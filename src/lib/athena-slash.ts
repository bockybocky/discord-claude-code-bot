import { Command } from "@sapphire/framework";

/** Sapphire command that does not self-register; index.ts REST.put owns Discord registry. */
export abstract class AthenaSlash extends Command {
  public override registerApplicationCommands(): void {
    // no-op: 斜線定義仍由 index.ts 一次送出，避免兩套覆寫。
  }
}
