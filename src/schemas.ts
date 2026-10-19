const text = { type: 'string' };
const list = { type: 'array', items: text };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const command = object({ argv: { type: 'array', items: text }, cwd: text });
const commands = { type: 'array', items: command };
export const planSchema = object({
  decision: { type: 'string', enum: ['implement', 'skip'] }, reason: text, summary: text,
  contributionPolicy: text, setup: commands, regression: commands, checks: commands,
});
export const workSchema = object({ status: { type: 'string', enum: ['done', 'blocked'] }, summary: text });
export const reviewSchema = object({
  verdict: { type: 'string', enum: ['approve', 'changes_requested'] }, summary: text,
  findings: list, regressionIsMeaningful: { type: 'boolean' }, policyCompliant: { type: 'boolean' }, title: text, body: text,
});
