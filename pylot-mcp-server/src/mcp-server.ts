import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";

const CONTENT_API_BASE = process.env.CONTENT_API_BASE ?? "https://api.mypylot.io/mvk-api";
const CONTENT_API_VERSION = process.env.CONTENT_API_VERSION ?? "v1";
const DEFAULT_DOMAIN = process.env.DEFAULT_DOMAIN ?? "www.imaginuity.com";

// Friendly alias -> actual contentType (extend as needed)
const CONTENT_TYPE_ALIASES: Record<string, string> = {
  blogs: "posts",
  blog: "posts",
  events: "mec-events",
  event: "mec-events",
};

function urlFor(path: string) {
  return `${CONTENT_API_BASE}/${CONTENT_API_VERSION}/${path.replace(/^\/+/, "")}`;
}

async function fetchJSON<T = any>(path: string): Promise<T> {
  const url = urlFor(path);
  const res = await fetch(url as any, { headers: { Accept: "application/json" } } as any);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upstream ${res.status} ${res.statusText} for ${url} :: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Normalize a slug->node map into a page of light-weight items */
function paginateMap(map: Record<string, any>, limit: number, offset: number) {
  const entries = Object.entries(map);
  const total = entries.length;
  const items = entries.slice(offset, offset + limit).map(([slug, node]) => ({
    slug,
    mvk_id: (node as any)?.mvk_id ?? null,
    title:
      (node as any)?.mvk_item_content?.title ??
      (node as any)?.title ??
      (node as any)?.mvk_item_seo?.seo_title ??
      slug,
    url: (node as any)?.mvk_item_meta?.url ?? null,
  }));
  return { total, limit, offset, items };
}

/** Resolve a user-provided contentType through alias mapping */
function resolveContentType(ct: string) {
  const lower = ct.toLowerCase();
  return CONTENT_TYPE_ALIASES[lower] ?? ct;
}

// Create MCP server
const server = new McpServer({
  name: "pylot-content-api",
  version: "0.2.1",
});

// ---------- Domain-scoped "virtual tools" registry ----------
server.registerTool(
  "content_tools_for_domain",
  {
    title: "Content Tools for Domain",
    description:
      "Return domain-driven virtual tools based on available content types. Includes alias-mapped tools (e.g., blogs -> posts, events -> mec-events).",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
    }),
  },
  async ({ domain = DEFAULT_DOMAIN }) => {
    const types = await fetchJSON<Record<string, any>>(
      `content/${encodeURIComponent(domain)}/content_types.json`
    );

    const registry: Array<any> = [];

    const addCT = (contentType: string, label?: string) => {
      const ctName = label ?? contentType;
      registry.push({
        contentType: ctName,
        tools: [
          {
            name: `${ctName}.list`,
            description: `List ${ctName} (paginated)`,
            inputSchema: {
              type: "object",
              properties: {
                domain: { type: "string", default: domain },
                limit: { type: "integer", default: 20, minimum: 1, maximum: 100 },
                offset: { type: "integer", default: 0, minimum: 0 },
              },
            },
            call_example: {
              method: "tools/call",
              params: {
                name: "list_items",
                arguments: { domain, contentType, limit: 20, offset: 0 },
              },
            },
          },
          {
            name: `${ctName}.get_by_slug`,
            description: `Get a ${ctName} item by slug`,
            inputSchema: {
              type: "object",
              properties: {
                domain: { type: "string", default: domain },
                slug: { type: "string" },
              },
              required: ["slug"],
            },
            call_example: {
              method: "tools/call",
              params: {
                name: "get_item_by_slug",
                arguments: { domain, contentType, slug: "<slug>" },
              },
            },
          },
          {
            name: `${ctName}.get_by_id`,
            description: `Get a ${ctName} item by mvk_id`,
            inputSchema: {
              type: "object",
              properties: {
                domain: { type: "string", default: domain },
                id: { type: "integer" },
              },
              required: ["id"],
            },
            call_example: {
              method: "tools/call",
              params: {
                name: "get_item_by_id",
                arguments: { domain, contentType, id: 123 },
              },
            },
          },
        ],
      });
    };

    // Real content types from the API
    Object.keys(types || {})
      .sort()
      .forEach((ct) => addCT(ct));

    // Also add alias views if they point to existing content types
    for (const [alias, target] of Object.entries(CONTENT_TYPE_ALIASES)) {
      if ((types as any)?.[target]) addCT(target, alias);
    }

    // Redirect helpers
    registry.push({
      contentType: "_redirects",
      tools: [
        {
          name: "redirects.map",
          description: "Fetch the redirects map for the domain",
          inputSchema: {
            type: "object",
            properties: { domain: { type: "string", default: domain } },
          },
          call_example: {
            method: "tools/call",
            params: { name: "list_redirects", arguments: { domain } },
          },
        },
        {
          name: "redirects.lookup",
          description: "Find redirect target for a given fromPath (e.g., '/old/')",
          inputSchema: {
            type: "object",
            properties: {
              domain: { type: "string", default: domain },
              fromPath: { type: "string" },
            },
            required: ["fromPath"],
          },
          call_example: {
            method: "tools/call",
            params: {
              name: "lookup_redirect",
              arguments: { domain, fromPath: "/old/" },
            },
          },
        },
      ],
    });

    // Search helpers
    registry.push({
      contentType: "_search",
      tools: [
        {
          name: "search.all",
          description: "Search the entire site",
          inputSchema: {
            type: "object",
            properties: {
              domain: { type: "string", default: domain },
              q: { type: "string" },
              top: { type: "integer", default: 20 },
            },
            required: ["q"],
          },
          call_example: {
            method: "tools/call",
            params: {
              name: "search_content",
              arguments: { domain, q: "<query>", top: 20 },
            },
          },
        },
        {
          name: "search.by_type",
          description: "Search and then filter by a result type (client-side filter)",
          inputSchema: {
            type: "object",
            properties: {
              domain: { type: "string", default: domain },
              q: { type: "string" },
              type: { type: "string", description: "e.g., 'page','post','services'" },
              top: { type: "integer", default: 20 },
            },
            required: ["q", "type"],
          },
          call_example: {
            method: "tools/call",
            params: {
              name: "search_content",
              arguments: { domain, q: "<query>", type: "page", top: 20 },
            },
          },
        },
      ],
    });

    return {
      content: [
        { type: "json", json: { domain, registry, aliases: CONTENT_TYPE_ALIASES } },
      ],
    };
  }
);

// ---------- Generic tools ----------
server.registerTool(
  "list_content_types",
  {
    title: "List Content Types",
    description: "List available content types for a given domain",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
    }),
  },
  async ({ domain = DEFAULT_DOMAIN }: { domain?: string }) => {
    const data = await fetchJSON<Record<string, any>>(
      `content/${encodeURIComponent(domain)}/content_types.json`
    );
    return { content: [{ type: "json", json: data }] };
  }
);

server.registerTool(
  "list_items",
  {
    title: "List Items",
    description:
      "List items for a contentType (paginated), returning slug, mvk_id, title, url",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
      contentType: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }),
  },
  async ({
    domain = DEFAULT_DOMAIN,
    contentType,
    limit = 20,
    offset = 0,
  }: {
    domain?: string;
    contentType: string;
    limit?: number;
    offset?: number;
  }) => {
    const resolved = resolveContentType(contentType);
    const map = await fetchJSON<Record<string, any>>(
      `content/${encodeURIComponent(domain)}/${encodeURIComponent(resolved)}.json`
    );
    const page = paginateMap(map, limit, offset);
    return { content: [{ type: "json", json: page }] };
  }
);

server.registerTool(
  "get_item_by_slug",
  {
    title: "Get Item by Slug",
    description: "Get a single item by slug for a given contentType",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
      contentType: z.string(),
      slug: z.string(),
    }),
  },
  async ({
    domain = DEFAULT_DOMAIN,
    contentType,
    slug,
  }: {
    domain?: string;
    contentType: string;
    slug: string;
  }) => {
    const resolved = resolveContentType(contentType);
    const map = await fetchJSON<Record<string, any>>(
      `content/${encodeURIComponent(domain)}/${encodeURIComponent(resolved)}.json`
    );
    const node = (map as any)?.[slug];
    if (!node) throw new Error(`No item with slug '${slug}' in ${resolved}`);
    const normalized = {
      slug,
      mvk_id: (node as any)?.mvk_id ?? null,
      title:
        (node as any)?.mvk_item_content?.title ??
        (node as any)?.title ??
        slug,
      url: (node as any)?.mvk_item_meta?.url ?? null,
    };
    return { content: [{ type: "json", json: { normalized, raw: node } }] };
  }
);

server.registerTool(
  "get_item_by_id",
  {
    title: "Get Item by ID",
    description:
      "Get a single item by mvk_id for a given contentType (scans the map)",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
      contentType: z.string(),
      id: z.number().int(),
    }),
  },
  async ({
    domain = DEFAULT_DOMAIN,
    contentType,
    id,
  }: {
    domain?: string;
    contentType: string;
    id: number;
  }) => {
    const resolved = resolveContentType(contentType);
    const map = await fetchJSON<Record<string, any>>(
      `content/${encodeURIComponent(domain)}/${encodeURIComponent(resolved)}.json`
    );
    let found: any = null;
    let foundSlug: string | null = null;
    for (const [slug, node] of Object.entries(map)) {
      const mvkId = (node as any)?.mvk_id ?? (node as any)?.mvk_item_meta?.mvk_id;
      if (mvkId === id) {
        found = node;
        foundSlug = slug;
        break;
      }
    }
    if (!found) throw new Error(`No item with mvk_id '${id}' in ${resolved}`);
    const normalized = {
      slug: foundSlug,
      mvk_id: (found as any)?.mvk_id ?? null,
      title:
        (found as any)?.mvk_item_content?.title ??
        (found as any)?.title ??
        (foundSlug as string),
      url: (found as any)?.mvk_item_meta?.url ?? null,
    };
    return { content: [{ type: "json", json: { normalized, raw: found } }] };
  }
);

server.registerTool(
  "list_redirects",
  {
    title: "List Redirects",
    description: "Return the redirects map for a domain",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
    }),
  },
  async ({ domain = DEFAULT_DOMAIN }: { domain?: string }) => {
    const map = await fetchJSON<Record<string, string>>(
      `content/${encodeURIComponent(domain)}/redirects.json`
    );
    return { content: [{ type: "json", json: map }] };
  }
);

server.registerTool(
  "lookup_redirect",
  {
    title: "Lookup Redirect",
    description: "Look up a single redirect by 'from' path (e.g., '/old-url/')",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
      fromPath: z.string(),
    }),
  },
  async ({
    domain = DEFAULT_DOMAIN,
    fromPath,
  }: {
    domain?: string;
    fromPath: string;
  }) => {
    const map = await fetchJSON<Record<string, string>>(
      `content/${encodeURIComponent(domain)}/redirects.json`
    );
    const to = map?.[fromPath] ?? null;
    return { content: [{ type: "json", json: { from: fromPath, to } }] };
  }
);

server.registerTool(
  "search_content",
  {
    title: "Search Content",
    description: "Full-site search via GET /search/?site={domain}&term={q}",
    inputSchema: z.object({
      domain: z.string().default(DEFAULT_DOMAIN),
      q: z.string().min(1, "Search term is required"),
      top: z.number().int().min(1).max(100).default(20),
      type: z.string().optional(), // client-side filter (e.g., 'page','services')
    }),
  },
  async ({
    domain = DEFAULT_DOMAIN,
    q,
    top = 20,
    type,
  }: {
    domain?: string;
    q: string;
    top?: number;
    type?: string;
  }) => {
    const searchPath = `search/?site=${encodeURIComponent(domain)}&term=${encodeURIComponent(q)}`;
    const data = await fetchJSON<{
      status: number;
      result_count: number;
      results: Array<{
        id: number;
        title: string;
        url: string;
        type: string;
        excerpt?: string;
        thumbnail?: any;
        relevance?: number;
      }>;
      response?: string;
    }>(searchPath);

    let items = data.results || [];
    if (type) items = items.filter((r) => r?.type === type);
    if (top) items = items.slice(0, top);

    const normalized = {
      total_reported: data.result_count ?? items.length,
      returned: items.length,
      items: items.map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        type: r.type,
        excerpt: r.excerpt ?? "",
        relevance: r.relevance ?? null,
        has_thumbnail: !!r.thumbnail,
      })),
    };

    return { content: [{ type: "json", json: { normalized, raw: data } }] };
  }
);

// Resources (optional, illustrative)
server.registerResource(
  "types",
  new ResourceTemplate(`resource://content/${DEFAULT_DOMAIN}/types`, { list: undefined }),
  {
    title: "Content types for default domain",
    description: "Content types for DEFAULT_DOMAIN",
  },
  async (uri) => {
    const data = await fetchJSON<Record<string, any>>(
      `content/${encodeURIComponent(DEFAULT_DOMAIN)}/content_types.json`
    );
    return { contents: [{ uri: uri.href, json: data }] };
  }
);

server.registerResource(
  "redirects",
  new ResourceTemplate(`resource://content/${DEFAULT_DOMAIN}/redirects`, { list: undefined }),
  {
    title: "Redirect map for default domain",
    description: "Redirects for DEFAULT_DOMAIN",
  },
  async (uri) => {
    const data = await fetchJSON<Record<string, string>>(
      `content/${encodeURIComponent(DEFAULT_DOMAIN)}/redirects.json`
    );
    return { contents: [{ uri: uri.href, json: data }] };
  }
);

// Start receiving/sending messages on stdio
const transport = new StdioServerTransport();
await server.connect(transport);
console.log(`[MCP] pylot-content-api over stdio | base=${CONTENT_API_BASE} version=${CONTENT_API_VERSION}`);
