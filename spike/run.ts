/** Non-interactive spike runner: streams every event so tool calls are visible. */
import { InMemoryRunner } from '@google/adk';
import { rootAgent } from './agent.js';

const runner = new InMemoryRunner({ agent: rootAgent });

import { appendFileSync } from 'node:fs';

for await (const event of runner.runEphemeral({
  userId: 'day1',
  newMessage: { role: 'user', parts: [{ text: 'check grafana' }] },
})) {
  appendFileSync('events.jsonl', JSON.stringify(event) + '\n');
  for (const p of event.content?.parts ?? []) {
    if (p.text) console.log(`[${event.author}] ${p.text.trim()}`);
    if (p.functionCall)
      console.log(`[${event.author}] CALL ${p.functionCall.name} ${JSON.stringify(p.functionCall.args)}`);
    if (p.functionResponse)
      console.log(
        `[${event.author}] RESULT ${p.functionResponse.name}: ${JSON.stringify(p.functionResponse.response).slice(0, 300)}`,
      );
  }
}
console.log('SPIKE COMPLETE');
process.exit(0);
