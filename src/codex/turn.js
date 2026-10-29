// 在一个 app-server 上跑一次"临时线程 + 单个回合"，把流式事件回调出去。
// 每个 API 请求都新建 ephemeral 线程：不落盘、互不串上下文。

export async function runTurn(client, { thread, input, turn, onEvent = () => {}, signal }) {
  const started = await client.request('thread/start', {
    ...thread,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
  });
  const threadId = started.thread.id;
  const result = {
    model: started.model,
    usage: null,
    messages: [],
    images: [],
    status: null,
    error: null,
  };
  const phases = new Map();
  onEvent({ type: 'started', model: started.model });

  return new Promise((resolve, reject) => {
    let turnId = null;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      client.request('thread/unsubscribe', { threadId }).catch(() => {});
      if (err) reject(err);
      else resolve(result);
    };

    const onAbort = () => {
      if (turnId) client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      finish(Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 }));
    };

    const unsubscribe = client.subscribeThread(threadId, (method, params) => {
      switch (method) {
        case 'item/started':
          if (params.item?.type === 'agentMessage') phases.set(params.item.id, params.item.phase);
          if (params.item?.type === 'imageGeneration') onEvent({ type: 'image_started', itemId: params.item.id });
          break;
        case 'item/agentMessage/delta': {
          // commentary 是模型的中间说明，归到 reasoning，不算正式回复。
          const type = phases.get(params.itemId) === 'commentary' ? 'reasoning' : 'text';
          onEvent({ type, delta: params.delta, itemId: params.itemId });
          break;
        }
        case 'item/reasoning/summaryTextDelta':
          onEvent({ type: 'reasoning', delta: params.delta, itemId: params.itemId });
          break;
        case 'item/completed':
          if (params.item?.type === 'agentMessage') {
            result.messages.push({ text: params.item.text, phase: params.item.phase });
          } else if (params.item?.type === 'imageGeneration') {
            // 内置 image_gen.imagegen 工具的结果：新版本可能只给 fileId（附件引用）而不内嵌 base64，
            // 但图片总会落盘到 CODEX_HOME/generated_images（app-server/src/extensions.rs），savedPath 指向它。
            const image = {
              id: params.item.id,
              status: params.item.status,
              revisedPrompt: params.item.revisedPrompt,
              b64: params.item.result || null,
              fileId: params.item.fileId || null,
              savedPath: params.item.savedPath || null,
              failure: params.item.failure || null,
            };
            result.images.push(image);
            onEvent({ type: 'image', image });
          }
          break;
        case 'thread/tokenUsage/updated':
          // 线程是本次请求新建的，total 就是本回合的用量。
          result.usage = params.tokenUsage.total;
          break;
        case 'error':
          if (!params.willRetry) result.error = params.error;
          break;
        case 'turn/completed':
          result.status = params.turn.status;
          if (params.turn.error) result.error = params.turn.error;
          if (result.status === 'completed') finish();
          else finish(turnError(result.error, result.status));
          break;
        case 'process/exited':
          finish(params.error);
          break;
      }
    });

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    client
      .request('turn/start', { threadId, input, ...turn })
      .then((r) => {
        turnId = r.turn.id;
        if (settled && signal?.aborted) {
          client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        }
      })
      .catch((err) => finish(err));
  });
}

// 回合最终文本：partial_answer（稳定的回答片段）和 final_answer 都是正式回答，commentary 是中间说明。
// 没有标注 phase 的旧模型，拼接所有非 commentary 消息。
export function finalText(messages) {
  const answers = messages.filter((m) => m.phase === 'final_answer' || m.phase === 'partial_answer');
  const picked = answers.length ? answers : messages.filter((m) => m.phase !== 'commentary');
  return picked.map((m) => m.text).join('\n\n');
}

const ERROR_STATUS = {
  usageLimitExceeded: 429,
  sessionBudgetExceeded: 429,
  rateLimitExceeded: 429,
  serverOverloaded: 503,
  flexUnavailable: 503,
  modelNotFound: 404,
  contextWindowExceeded: 400,
  badRequest: 400,
  // 上游登录失效不是调用方 API Key 的问题，返回 503 提示去后台重新登录。
  unauthorized: 503,
  cyberPolicy: 400,
  misalignmentPolicyViolation: 400,
  tooManyDenials: 400,
};

function turnError(error, status) {
  const info = error?.codexErrorInfo;
  const code = typeof info === 'string' ? info : info ? Object.keys(info)[0] : status;
  const err = new Error(error?.message || `Codex 回合结束状态：${status}`);
  err.status = ERROR_STATUS[code] || 502;
  err.code = code;
  if (error?.additionalDetails) err.details = error.additionalDetails;
  return err;
}
