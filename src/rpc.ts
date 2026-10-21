import { Rpc } from "@opencode/plugin/rpc";

const windowSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    percent: { type: "number" },
    resetsAt: { type: "string" },
  },
  additionalProperties: false,
} as const;

const errorSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    status: { type: "number" },
  },
  required: ["message"],
  additionalProperties: false,
} as const;

export const GoUsageRpc = Rpc.define({
  id: "opencode-go-usage",
  methods: {
    getUsage: {
      input: {
        type: "object",
        properties: {
          baseUrl: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          rolling: windowSchema,
          weekly: windowSchema,
          monthly: windowSchema,
        },
        additionalProperties: false,
      },
      errors: {
        "no-key": errorSchema,
        config: errorSchema,
        unauthorized: errorSchema,
        "no-subscription": errorSchema,
        "bad-response": errorSchema,
        network: errorSchema,
        http: errorSchema,
      },
    },
  },
  events: {},
});
