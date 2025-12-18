import { Context, Schema, HTTP, Logger } from "koishi";
import { createParser } from "eventsource-parser";
import path from "node:path";
import fs from "node:fs";

export const name = "closure-studio";

export const inject = ["database"];

export interface Config {
  email: string;
  password: string;
  debug?: boolean;
  noticeList?: string[];
}

export const Config: Schema<Config> = Schema.object({
  email: Schema.string().required(),
  password: Schema.string().required(),
  debug: Schema.boolean().default(false).description("是否启用调试日志"),
  noticeList: Schema.array(Schema.string())
    .default([])
    .description(
      "需要通知的频道列表，格式为{platform}:{channelId}\n\n例如：telegram:123456789, discord:123456789",
    ),
});

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const dataMap = new Map<string, string>();

export async function apply(
  ctx: Context,
  { email, password, debug, noticeList }: Config,
) {
  const logger = ctx.logger("closure-studio");
  logger.level = debug ? Logger.DEBUG : Logger.INFO;
  const pluginDataPath = path.join(ctx.baseDir, "data", "closure-studio");
  const tokenPath = path.join(pluginDataPath, "token");
  // Make sure token file exists
  fs.mkdirSync(pluginDataPath, { recursive: true });
  if (!fs.existsSync(tokenPath)) {
    fs.closeSync(fs.openSync(tokenPath, "a"));
  }

  ctx.command("closure", "Closure Studio");

  ctx.command("closure.status", "Closure Studio 状态").action(() => {
    const [{ status }] = JSON.parse(dataMap.get("gameInfo"));
    return [
      `用户名: ${status.nick_name}`,
      `等级: ${status.level}`,
      `状态: ${status.text}`,
    ].join("\n");
  });

  const http: HTTP = ctx.http.extend({
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  const getToken = async ({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<string> => {
    return http
      .post("https://passport.ltsc.vip/api/v1/login", {
        email,
        password,
      })
      .then((res) => res.data.token);
  };

  const getMe = async (token: string) => {
    return http.get("https://registry.ltsc.vip/api/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  };

  const sleep = (ms: number, signal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  let token = fs.readFileSync(tokenPath, "utf-8");
  if (token) {
    getMe(token).catch(() => {
      token = "";
      logger.warn("Token expired");
    });
  }

  if (!token) {
    token = await getToken({ email, password });
    fs.writeFileSync(tokenPath, token);
    logger.info("Token updated", token);
  }

  const gameUrl = new URL("https://api-tunnel.arknights.app/sse/games");
  gameUrl.searchParams.set("token", token);

  // SSE Stream (auto reconnect)
  const lifecycle = new AbortController();
  let streamController: AbortController | null = null;
  let reconnectAttempts = 0;

  const isAuthError = (err: unknown) => {
    const anyErr = err as any;
    const status = anyErr?.response?.status ?? anyErr?.status;
    return status === 401 || status === 403;
  };

  const refreshToken = async () => {
    const next = await getToken({ email, password });
    token = next;
    fs.writeFileSync(tokenPath, token);
    gameUrl.searchParams.set("token", token);
    logger.info("Token updated", token);
  };

  const connectOnce = async () => {
    streamController = new AbortController();
    const onLifecycleAbort = () => streamController?.abort();
    lifecycle.signal.addEventListener("abort", onLifecycleAbort, {
      once: true,
    });
    try {
      const gameEventStream = await http.get(gameUrl.href, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        responseType: "stream",
        signal: streamController.signal,
      });

      reconnectAttempts = 0;
      logger.info("Game event stream connected");

      const decoder = new TextDecoder();
      for await (const chunk of gameEventStream) {
        if (lifecycle.signal.aborted) break;
        parser.feed(decoder.decode(chunk, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) parser.feed(tail);
      throw new Error("stream ended");
    } finally {
      lifecycle.signal.removeEventListener("abort", onLifecycleAbort);
      streamController = null;
    }
  };

  ctx.on("dispose", () => {
    lifecycle.abort();
    streamController?.abort();
  });

  const parser = createParser({
    onEvent: (event) => {
      logger.debug(event);

      if (event.event === "game") dataMap.set("gameInfo", event.data);

      if (event.event === "log") {
        const { content } = JSON.parse(event.data);
        if (content) ctx.broadcast(noticeList, content);
      }
    },
    onError: (error) => {
      logger.error(error);
    },
  });

  while (!lifecycle.signal.aborted) {
    try {
      await connectOnce();
    } catch (err) {
      if (lifecycle.signal.aborted) break;

      if (isAuthError(err)) {
        logger.warn("Game event stream auth failed, refreshing token...");
        try {
          await refreshToken();
        } catch (refreshErr) {
          logger.error(refreshErr);
        }
      } else {
        logger.warn(err);
      }

      reconnectAttempts++;
      const base = Math.min(
        30_000,
        1_000 * 2 ** Math.min(reconnectAttempts, 5),
      );
      const jitter = Math.floor(Math.random() * 500);
      const delay = base + jitter;
      logger.info(`Reconnect in ${delay}ms (attempt ${reconnectAttempts})`);

      try {
        await sleep(delay, lifecycle.signal);
      } catch {
        break;
      }
    }
  }
}
