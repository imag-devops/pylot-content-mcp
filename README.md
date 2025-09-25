# Pylot MCP Server (read-only)

An MCP server exposing read-only tools over the Pylot headless content API.

## Quick start

```bash
git clone [<this repo>](https://github.com/imag-devops/pylot-content-mcp.git)
cd pylot-mcp-server
npm install
npm run build
npm start
```

Environment variables (optional):

- `CONTENT_API_BASE` (default: `https://api.mypylot.io/mvk-api`)
- `CONTENT_API_VERSION` (default: `v1`)
- `DEFAULT_DOMAIN` (default: `www.imaginuity.com`)

## What it exposes

- Domain-driven **virtual tools** (from `/content/{domain}/content_types.json`)
- Generic tools:
  - `list_content_types`
  - `list_items`
  - `get_item_by_slug`
  - `get_item_by_id`
  - `list_redirects`
  - `lookup_redirect`
  - `search_content` (GET `/search/?site={domain}&term={q}`)

**Aliases:** maps friendly names to content types (e.g. `blogs -> posts`, `events -> mec-events`).

## Using with an MCP client

This server speaks MCP over **stdio**. Point your client to run the CLI:

```bash
pylot-mcp-server
```

Then within your MCP client, start by calling:

- `content_tools_for_domain({ domain: "www.imaginuity.com" })`

This returns a registry of virtual tools (e.g., `pages.list`, `pages.get_by_slug`, `search.all`, `blogs.list` -> `posts`, etc.), each with a ready-to-use call example.

## Common examples

- Latest 3 blog articles (blogs = posts):
  1) Call `content_tools_for_domain(domain)`, find tool `blogs.list`
  2) Invoke `list_items({ domain, contentType: "posts", limit: 3 })`

- Events (map to `mec-events`):
  - `list_items({ domain, contentType: "mec-events", limit: 10 })`

## Notes

- Docker is **not required**; this runs locally via stdio.
- Sorting by recency is not implemented (can be added later if needed).
