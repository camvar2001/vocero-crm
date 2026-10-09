import { z } from "zod";

export const INMOB_AGENTS = ["secretaria", "buscador"] as const;
export const InmobAgentSchema = z.enum(INMOB_AGENTS);
export type InmobAgent = z.infer<typeof InmobAgentSchema>;

export const InmobResultSchema = z.object({
  title: z.string().trim().min(1).max(240),
  url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  source: z.string().trim().min(1).max(120),
}).strict();
export type InmobResult = z.infer<typeof InmobResultSchema>;

export const InmobTurnSchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  reply: z.string().max(32000).nullable(),
  status: z.enum(["running", "completed", "failed", "uncertain"]),
  errorCode: z.string().max(80).nullable(),
  results: z.array(InmobResultSchema).max(100),
  createdAt: z.string().datetime(),
}).strict();
export type InmobTurn = z.infer<typeof InmobTurnSchema>;

export const InmobChatSchema = z.object({
  chatId: z.string().min(1),
  agent: InmobAgentSchema,
  turns: z.array(InmobTurnSchema).max(100),
}).strict();
export type InmobChat = z.infer<typeof InmobChatSchema>;

export const InmobPostBodySchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
}).strict();
export type InmobPostBody = z.infer<typeof InmobPostBodySchema>;

export const InmobHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(32000),
}).strict();
export type InmobHistoryMessage = z.infer<typeof InmobHistoryMessageSchema>;

export const InmobToolSchema = z.object({
  name: z.enum([
    "contact_search",
    "contact_create",
    "agenda_availability",
    "agenda_list",
    "agenda_create",
    "agenda_update",
    "agenda_cancel",
  ]),
  arguments: z.record(z.unknown()),
}).strict();
export type InmobTool = z.infer<typeof InmobToolSchema>;

export const InmobToolResultSchema = z.object({
  toolCallId: z.string().uuid(),
  name: InmobToolSchema.shape.name,
  ok: z.boolean(),
  result: z.unknown(),
}).strict();
export type InmobToolResult = z.infer<typeof InmobToolResultSchema>;

export const InmobGatewayBaseRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  agent: InmobAgentSchema,
  sessionId: z.string().min(1).max(300),
  organizationId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
  advisorId: z.string().min(1).max(200),
  advisorPhone: z.string().min(7).max(20),
  message: z.string().min(1).max(4000),
  history: z.array(InmobHistoryMessageSchema).max(40),
  toolResult: InmobToolResultSchema.optional(),
  toolResults: z.array(InmobToolResultSchema).max(4).optional(),
}).strict();
export type InmobGatewayRequest = z.infer<typeof InmobGatewayBaseRequestSchema>;

export const InmobGatewayCompletedSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  agent: InmobAgentSchema,
  status: z.literal("completed"),
  reply: z.string().trim().min(1).max(32000),
  results: z.array(InmobResultSchema).max(100).optional(),
}).strict();

export const InmobGatewayToolRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  agent: z.literal("secretaria"),
  status: z.literal("tool_request"),
  toolCallId: z.string().uuid(),
  tool: InmobToolSchema,
}).strict();

export const InmobGatewayResponseSchema = z.discriminatedUnion("status", [
  InmobGatewayCompletedSchema,
  InmobGatewayToolRequestSchema,
]);
export type InmobGatewayResponse = z.infer<typeof InmobGatewayResponseSchema>;

export function parseInmobGatewayResponse(
  value: unknown,
  expected: { requestId: string; agent: InmobAgent }
): InmobGatewayResponse {
  const response = InmobGatewayResponseSchema.parse(value);
  if (response.requestId !== expected.requestId || response.agent !== expected.agent) {
    throw new Error("Gateway response identity mismatch");
  }
  return response;
}
