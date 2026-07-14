/**
 * Analytics tools: get_email_stats, get_email_analytics, get_contacts,
 * get_volume_trends.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ContactSortBy } from "../services/analytics-service.js";
import type { ToolDef, ToolHandler, ToolModule } from "./types.js";
import { clampOptionalInt } from "../utils/helpers.js";

export const defs: ToolDef[] = [
  {
    name: "get_email_stats",
    title: "Get Email Statistics",
    description:
      "Return a compact inbox-and-sent dashboard: totals, unread count, most active contact, and storage estimate. Use get_email_analytics for deeper breakdowns or get_volume_trends for a custom date window. Results are cached for 5 minutes.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        totalEmails: { type: "number" },
        unreadEmails: { type: "number" },
        starredEmails: { type: "number" },
        totalFolders: { type: "number" },
        totalContacts: { type: "number" },
        averageEmailsPerDay: { type: "number" },
        mostActiveContact: { type: "string" },
        mostUsedFolder: { type: "string" },
        storageUsedMB: { type: "number" },
      },
      required: ["totalEmails", "unreadEmails", "totalContacts"],
    },
  },
  {
    name: "get_email_analytics",
    title: "Get Email Analytics",
    description:
      "Return a detailed inbox-and-sent dashboard: top senders/recipients, peak hours, attachment stats, and measured response times (null when insufficient data). Use get_email_stats for a compact overview or get_volume_trends for a custom date window. Results are cached for 5 minutes.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        volumeTrends: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              received: { type: "number" },
              sent: { type: "number" },
            },
          },
        },
        topSenders: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              count: { type: "number", description: "Number of emails received from this sender" },
              lastContact: { type: "string", format: "date-time" },
            },
            required: ["email", "count", "lastContact"],
          },
        },
        topRecipients: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              count: { type: "number", description: "Number of emails sent to this recipient" },
              lastContact: { type: "string", format: "date-time" },
            },
            required: ["email", "count", "lastContact"],
          },
        },
        responseTimeStats: {
          description: "Null when no sent replies could be matched to received emails.",
          oneOf: [
            {
              type: "object",
              properties: {
                average: { type: "number", description: "Average hours" },
                median: { type: "number" },
                fastest: { type: "number" },
                slowest: { type: "number" },
                sampleSize: { type: "number" },
              },
              required: ["average", "median", "fastest", "slowest", "sampleSize"],
            },
            { type: "null" },
          ],
        },
        peakActivityHours: {
          type: "array",
          items: {
            type: "object",
            properties: {
              hour: { type: "number", description: "Hour of day (0–23)" },
              count: { type: "number", description: "Number of emails in this hour" },
            },
            required: ["hour", "count"],
          },
        },
        attachmentStats: {
          type: "object",
          properties: {
            totalAttachments: { type: "number" },
            totalSizeMB: { type: "number" },
            averageSizeMB: { type: "number" },
            mostCommonTypes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", description: "MIME top-level type (e.g. image, application)" },
                  count: { type: "number" },
                },
                required: ["type", "count"],
              },
            },
          },
          required: ["totalAttachments", "totalSizeMB", "averageSizeMB", "mostCommonTypes"],
        },
      },
      required: ["volumeTrends", "topSenders", "topRecipients"],
    },
  },
  {
    name: "get_contacts",
    title: "Get Contacts",
    description:
      "Extract a ranked contact list from inbox and sent history, including send/receive counts, last interaction, inferred organization, and recency. Use this to choose recipients; use get_correspondence_profile for one relationship in depth.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max contacts to return (default 100, max 500)", default: 100 },
        sortBy: {
          type: "string",
          enum: ["recent", "total", "sent", "received"],
          description: "Sort order: recent = recency-weighted total (default), total = raw interaction count, sent = emails you sent them, received = emails they sent you",
          default: "recent",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        contacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email:            { type: "string" },
              name:             { type: "string", description: "Display name seen in email headers" },
              domain:           { type: "string", description: "Email domain (e.g. anthropic.com)" },
              organization:     { type: "string", description: "Inferred org name; absent for personal providers" },
              emailsSent:       { type: "number" },
              emailsReceived:   { type: "number" },
              lastInteraction:  { type: "string", format: "date-time" },
              firstInteraction: { type: "string", format: "date-time" },
            },
            required: ["email", "domain", "emailsSent", "emailsReceived", "lastInteraction", "firstInteraction"],
          },
        },
      },
      required: ["contacts"],
    },
  },
  {
    name: "get_volume_trends",
    title: "Get Volume Trends",
    description: "Return daily sent/received volume for a caller-selected time window. Use get_email_analytics for the broader default dashboard, or get_unread_count for current unread counts.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to include", default: 30 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        trends: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "ISO 8601 date (YYYY-MM-DD)" },
              received: { type: "number" },
              sent: { type: "number" },
            },
            required: ["date", "received", "sent"],
          },
        },
      },
      required: ["trends"],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  get_email_stats: async (ctx) => {
    const { analyticsService, ok, getAnalyticsEmails } = ctx;
    await getAnalyticsEmails();
    const stats = analyticsService.getEmailStats();
    return ok(stats as unknown as Record<string, unknown>);
  },

  get_email_analytics: async (ctx) => {
    const { analyticsService, ok, getAnalyticsEmails } = ctx;
    await getAnalyticsEmails();
    const analytics = analyticsService.getEmailAnalytics();
    return ok(analytics as unknown as Record<string, unknown>);
  },

  get_contacts: async (ctx) => {
    const { args, analyticsService, ok, limits, getAnalyticsEmails } = ctx;
    if (args.limit !== undefined && typeof args.limit !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "'limit' must be a number.");
    }
    const VALID_SORT: ContactSortBy[] = ["recent", "total", "sent", "received"];
    if (args.sortBy !== undefined && !VALID_SORT.includes(args.sortBy as ContactSortBy)) {
      throw new McpError(ErrorCode.InvalidParams, `'sortBy' must be one of: ${VALID_SORT.join(", ")}.`);
    }
    await getAnalyticsEmails();
    // Clamp to [1, maxEmailListResults] with a finite-integer floor: a truthy
    // negative (e.g. -50) previously slipped past `|| 100` into Math.min and
    // returned a negative limit (TOOL-003).
    const contactLimit = clampOptionalInt(args.limit, 100, 1, limits.maxEmailListResults);
    const sortBy = (args.sortBy as ContactSortBy | undefined) ?? "recent";
    const contacts = analyticsService.getContacts(contactLimit, sortBy);
    return ok({ contacts });
  },

  get_volume_trends: async (ctx) => {
    const { args, analyticsService, ok, getAnalyticsEmails } = ctx;
    if (args.days !== undefined && typeof args.days !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "'days' must be a number.");
    }
    await getAnalyticsEmails();
    // Clamp days to [1, 365]; -10/0/NaN/Infinity previously forwarded raw and
    // the service's own `Math.trunc(days) || 30` fallback only caught 0/NaN,
    // not negatives or Infinity (TOOL-004).
    const days = args.days === undefined ? undefined : clampOptionalInt(args.days, 30, 1, 365);
    const trends = analyticsService.getVolumeTrends(days);
    return ok({ trends });
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
