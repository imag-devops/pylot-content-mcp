import { createServer } from "@modelcontextprotocol/sdk/server";
import { Tool } from "@modelcontextprotocol/sdk/types";
import fetch from "node-fetch";

const CONTENT_API_BASE = process.env.CONTENT_API_BASE ?? "https://api.mypylot.io/mvk-api";
const CONTENT_API_VERSION = process.env.CONTENT_API_VERSION ?? "v1";
const DEFAULT_DOMAIN = process.env.DEFAULT_DOMAIN ?? "www.imaginuity.com";

// Friendly alias -> actual contentType (extend as needed)
const CONTENT_TYPE_ALIASES: Record<string, string> = {
  blogs: "posts",
  blog: "posts",
  events: "mec-events",
  event: "mec-events"
};

function urlFor(path: string) {
  return `${CONTENT_API_BASE}/${CONTENT_API_VERSION}/${path.replace(/^\/+/, "")}`;
}

async function fetchJSON<T = any>(path: string): Promise<T> {
  const url = urlFor(path);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upstream ${res.status} ${res.statusText} for ${url} :: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Normalize a slug->node map into a page of light-weight items */
function paginateMap(map: Record<string, any>, limit: number, offset: number) {
  const entries = Object.entries(map);
  const total = entries.length;
  const items = entries.slice(offset, offset + limit).map(([slug, node]) => ({
    slug,
    mvk_id: node?.mvk_id ?? null,
    title:
      node?.mvk_item_content?.title ??
      node?.title ??
      node?.mvk_item_seo?.seo_title ??
      slug,
    url: node?.mvk_item_meta?.url ?? null
  }));
  return { total, limit, offset, items };
}

/** Resolve a user-provided contentType through alias mapping */
function resolveContentType(ct: string) {
  const lower = ct.toLowerCase();
  return CONTENT_TYPE_ALIASES[lower] ?? ct;
}

const tools: Tool[] = [
  // ---------- Domain-scoped "virtual tools" registry ----------
  {
    name: "content_tools_for_domain",
    description:
      "Return domain-driven virtual tools based on available content types. Includes alias-mapped tools (e.g., blogs -> posts, events -> mec-events).",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", default: DEFAULT_DOMAIN } }
    },
    async *invoke({ domain = DEFAULT_DOMAIN }) {
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
              name: `${ctName}.list`, description: `List ${ctName} (paginated)`,
              inputSchema: {
                type: "object",
                properties: {
                  domain: { type: "string", default: domain },
                  limit: { type: "integer", default: 20, minimum: 1, maximum: 100 },
                  offset: { type: "integer", default: 0, minimum: 0 }
                }
              },
              call_example: {
                method: "tools/call",
                params: { name: "list_items", arguments: { domain, contentType, limit: 20, offset: 0 } }
              }
            },
            {
              name: `${ctName}.get_by_slug`, description: `Get a ${ctName} item by slug`,
              inputSchema: {
                type: "object",
                properties: { domain: { type: "string", default: domain }, slug: { type: "string" } },
                required: ["slug"]
              },
              call_example: {
                method: "tools/call",
                params: { name: "get_item_by_slug", arguments: { domain, contentType, slug: "<slug>" } }
              }
            },
            {
              name: `${ctName}.get_by_id`, description: `Get a ${ctName} item by mvk_id`,
              inputSchema: {
                type: "object",
                properties: { domain: { type: "string", default: domain }, id: { type: "integer" } },
                required: ["id"]
              },
              call_example: {
                method: "tools/call",
                params: { name: "get_item_by_id", arguments: { domain, contentType, id: 123 } }
              }
            }
          ]
        });
      };

      // Real content types from the API
      Object.keys(types || {}).sort().forEach((ct) => addCT(ct));

      // Also add alias views if they point to existing content types
      for (const [alias, target] of Object.entries(CONTENT_TYPE_ALIASES)) {
        if (types?.[target]) addCT(target, alias);
      }

      // Redirect helpers
      registry.push({
        contentType: "_redirects",
        tools: [
          {
            name: "redirects.map",
            description: "Fetch the redirects map for the domain",
            inputSchema: { type: "object", properties: { domain: { type: "string", default: domain } } },
            call_example: { method: "tools/call", params: { name: "list_redirects", arguments: { domain } } }
          },
          {
            name: "redirects.lookup",
            description: "Find redirect target for a given fromPath (e.g., '/old/')",
            inputSchema: {
              type: "object",
              properties: { domain: { type: "string", default: domain }, fromPath: { type: "string" } },
              required: ["fromPath"]
            },
            call_example: { method: "tools/call", params: { name: "lookup_redirect", arguments: { domain, fromPath: "/old/" } } }
          }
        ]
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
              properties: { domain: { type: "string", default: domain }, q: { type: "string" }, top: { type: "integer", default: 20 } },
              required: ["q"]
            },
            call_example: { method: "tools/call", params: { name: "search_content", arguments: { domain, q: "<query>", top: 20 } } }
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
                top: { type: "integer", default: 20 }
              },
              required: ["q", "type"]
            },
            call_example: { method: "tools/call", params: { name: "search_content", arguments: { domain, q: "<query>", type: "page", top: 20 } } }
          }
        ]
      });

      return { content: [{ type: "json", json: { domain, registry, aliases: CONTENT_TYPE_ALIASES } }] };
    }
  },

  // ---------- Generic tools ----------
  {
    name: "list_content_types",
    description: "List available content types for a given domain",
    inputSchema: { type: "object", properties: { domain: { type: "string", default: DEFAULT_DOMAIN } } },
    async *invoke({ domain = DEFAULT_DOMAIN }) {
      const data = await fetchJSON<Record<string, any>>(
        `content/${encodeURIComponent(domain)}/content_types.json`
      );
      return { content: [{ type: "json", json: data }] };
    }
  },
  {
    name: "list_items",
    description: "List items for a contentType (paginated), returning slug, mvk_id, title, url",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", default: DEFAULT_DOMAIN },
        contentType: { type: "string" },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        offset: { type: "integer", default: 0, minimum: 0 }
      },
      required: ["contentType"]
    },
    async *invoke({ domain = DEFAULT_DOMAIN, contentType, limit = 20, offset = 0 }) {
      const resolved = resolveContentType(contentType);
      const map = await fetchJSON<Record<string, any>>(
        `content/${encodeURIComponent(domain)}/${encodeURIComponent(resolved)}.json`
      );
      const page = paginateMap(map, limit, offset);
      return { content: [{ type: "json", json: page }] };
    }
  },
  {
    name: "get_item_by_slug",
    description: "Get a single item by slug for a given contentType",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", default: DEFAULT_DOMAIN }, contentType: { type: "string" }, slug: { type: "string" } },
      required: ["contentType", "slug"]
    },
    async *invoke({ domain = DEFAULT_DOMAIN, contentType, slug }) {
      const resolved = resolveContentType(contentType);
      const map = await fetchJSON<Record<string, any>>(
        `content/${encodeURIComponent(domain)}/${encodeURIComponent(resolved)}.json`
      );
      const node = map?.[slug];
      if (!node) throw new Error(`No item with slug '${slug}' in ${resolved}`);
      const normalized = {
        slug,
        mvk_id: node?.mvk_id ?? null,
        title: node?.mvk_item_content?.title ?? node?.title ?? slug,
        url: node?.mvk_item_meta?.url ?? null
      };
      return { content: [{ type: "json", json: { normalized, raw: node } }] };
    }
  },
  {
    name: "get_item_by_id",
    description: "Get a single item by mvk_id for a given contentType (scans the map)",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", default: DEFAULT_DOMAIN }, contentType: { type: "string" }, id: { type: "integer" } },
      required: ["contentType", "id"]
    },
    async *invoke({ domain = DEFAULT_DOMAIN, contentType, id }) {
      const resolved = resolveContentType(contentType);
      const map = await fetchJSON<Record<string, any>>(
        `content/${encodeURIComponent(domain)}/${encodeURIComponent(resolved)}.json`
      );
      let found: any = null;
      let foundSlug: string | null = null;
      for (const [slug, node] of Object.entries(map)) {
        const mvkId = node?.mvk_id ?? node?.mvk_item_meta?.mvk_id;
        if (mvkId === id) { found = node; foundSlug = slug; break; }
      }
      if (!found) throw new Error(`No item with mvk_id '${id}' in ${resolved}`);
      const normalized = {
        slug: foundSlug,
        mvk_id: found?.mvk_id ?? null,
        title: found?.mvk_item_content?.title ?? found?.title ?? foundSlug,
        url: found?.mvk_item_meta?.url ?? null
      };
      return { content: [{ type: "json", json: { normalized, raw: found } }] };
    }
  },
  {
    name: "list_redirects",
    description: "Return the redirects map for a domain",
    inputSchema: { type: "object", properties: { domain: { type: "string", default: DEFAULT_DOMAIN } } },
    async *invoke({ domain = DEFAULT_DOMAIN }) {
      const map = await fetchJSON<Record<string, string>>(
        `content/${encodeURIComponent(domain)}/redirects.json`
      );
      return { content: [{ type: "json", json: map }] };
    }
  },
  {
    name: "lookup_redirect",
    description: "Look up a single redirect by 'from' path (e.g., '/old-url/')",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", default: DEFAULT_DOMAIN }, fromPath: { type: "string" } },
      required: ["fromPath"]
    },
    async *invoke({ domain = DEFAULT_DOMAIN, fromPath }) {
      const map = await fetchJSON<Record<string, string>>(
        `content/${encodeURIComponent(domain)}/redirects.json`
      );
      const to = map?.[fromPath] ?? null;
      return { content: [{ type: "json", json: { from: fromPath, to } }] };
    }
  },
  {
    name: "search_content",
    description: "Full-site search via GET /search/?site={domain}&term={q}",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", default: DEFAULT_DOMAIN },
        q: { type: "string", description: "Search term" },
        top: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        type: { type: "string", description: "Optional client-side filter by result.type (e.g., 'page','services')" }
      },
      required: ["q"]
    },
    async *invoke({ domain = DEFAULT_DOMAIN, q, top = 20, type }) {
      if (!q || !q.trim()) throw new Error("q is required");
      const searchPath = `search/?site=${encodeURIComponent(domain)}&term=${encodeURIComponent(q)}`;
      const data = await fetchJSON<{
        status: number;
        result_count: number;
        results: Array<{ id: number; title: string; url: string; type: string; excerpt?: string; thumbnail?: any; relevance?: number; }>;
        response?: string;
      }>(searchPath);

      let items = data.results || [];
      if (type) items = items.filter(r => r?.type === type);
      if (top) items = items.slice(0, top);

      const normalized = {
        total_reported: data.result_count ?? items.length,
        returned: items.length,
        items: items.map(r => ({
          id: r.id,
          title: r.title,
          url: r.url,
          type: r.type,
          excerpt: r.excerpt ?? "",
          relevance: r.relevance ?? null,
          has_thumbnail: !!r.thumbnail
        }))
      };

      return { content: [{ type: "json", json: { normalized, raw: data } }] };
    }
  }
];

const server = createServer({
  name: "pylot-content-api",
  version: "0.2.0",
  tools,
  resources: [
    { uri: `resource://content/${DEFAULT_DOMAIN}/types`, mimeType: "application/json", description: "Content types for default domain" },
    { uri: `resource://content/${DEFAULT_DOMAIN}/redirects`, mimeType: "application/json", description: "Redirect map for default domain" }
  ]
});

server.startStdio();
console.log(`[MCP] pylot-content-api over stdio | base=${CONTENT_API_BASE} version=${CONTENT_API_VERSION}`);
