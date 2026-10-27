/// <reference lib="webworker" />
/**
 * Runs the WebLLM engine off the main thread so that model compilation and
 * token generation never freeze the terminal's CRT animations or typing.
 */
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};
