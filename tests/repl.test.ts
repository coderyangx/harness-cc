import { afterEach, describe, expect, test, vi } from "vitest";
import { startRepl } from "../src/core/repl";

describe("startRepl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("pauses stdin when quitting immediately", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "once").mockImplementation(((event: string, handler: (chunk: Buffer | string) => void) => {
      if (event === "data") {
        handler("q\n");
      }
      return process.stdin;
    }) as any);

    await startRepl({
      sessionId: "s01",
      runTurn: async () => {
        throw new Error("runTurn should not be called when quitting");
      }
    });

    expect(writeSpy).toHaveBeenCalled();
    expect(resumeSpy).toHaveBeenCalled();
    expect(pauseSpy).toHaveBeenCalled();
  });
});
