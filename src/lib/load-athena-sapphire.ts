import type { SapphireClient } from "@sapphire/framework";
import { AthenaHoldingsCommand } from "../commands/athena-holdings.js";
import { AthenaTodayCommand } from "../commands/athena-today.js";
import { AthenaScoutCommand } from "../commands/athena-scout.js";
import { AthenaStatusCommand } from "../commands/athena-status.js";
import { AthenaHealthCommand } from "../commands/athena-health.js";
import { AthenaInsightCommand } from "../commands/athena-insight.js";
import { AthenaAskBrainCommand } from "../commands/athena-ask-brain.js";
import { AthenaRetryCommand } from "../commands/athena-retry.js";
import { AthenaCalendarCommand } from "../commands/athena-calendar.js";
import { AthenaCalendarConfirmCommand } from "../commands/athena-calendar-confirm.js";
import { AthenaMailCommand } from "../commands/athena-mail.js";
import { AthenaMailConfirmCommand } from "../commands/athena-mail-confirm.js";

const PIECES = [
  { name: "athena-holdings", piece: AthenaHoldingsCommand },
  { name: "athena-today", piece: AthenaTodayCommand },
  { name: "athena-scout", piece: AthenaScoutCommand },
  { name: "athena-status", piece: AthenaStatusCommand },
  { name: "athena-health", piece: AthenaHealthCommand },
  { name: "athena-insight", piece: AthenaInsightCommand },
  { name: "athena-ask-brain", piece: AthenaAskBrainCommand },
  { name: "athena-retry", piece: AthenaRetryCommand },
  { name: "athena-calendar", piece: AthenaCalendarCommand },
  { name: "athena-calendar-confirm", piece: AthenaCalendarConfirmCommand },
  { name: "athena-mail", piece: AthenaMailCommand },
  { name: "athena-mail-confirm", piece: AthenaMailConfirmCommand },
];

export async function loadAthenaSapphireCommands(client: SapphireClient): Promise<number> {
  const store = client.stores.get("commands");
  for (const entry of PIECES) {
    await store.loadPiece(entry as any);
  }
  return store.size;
}
