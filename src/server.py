"""
Kapruka MCP Server with Conversational Chat Router

Exposes Kapruka.com REST API tools and provides a /chat endpoint
that interprets user queries and calls the correct MCP tool.
"""

import logging
from pathlib import Path
import re

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Route
from starlette.middleware.cors import CORSMiddleware

from src.activity_log import ActivityLogger, ActivityLogMiddleware
from src.cache import cache
from src.config.settings import settings
from src.middleware import RateLimitMiddleware
from src.order_rate_limit import OrderRateLimitMiddleware
from src.well_known import well_known_mcp, well_known_mcp_options

# ── Static landing page
_STATIC_DIR = Path(__file__).parent / "static"
_LANDING_HTML = (_STATIC_DIR / "index.html").read_text(encoding="utf-8")

# ── Logging setup
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── MCP server
mcp = FastMCP(
    "kapruka_mcp",
    instructions=(
        "You are connected to the Kapruka MCP server, which provides access "
        "to Kapruka.com — Sri Lanka's largest e-commerce platform. Use the available "
        "tools to search products, browse categories, check delivery, create orders, "
        "and track orders."
    ),
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=settings.enable_dns_rebinding_protection,
        allowed_hosts=settings.public_hosts,
        allowed_origins=settings.public_origins,
    ),
)

# ── Tool modules: importing them registers their @mcp.tool decorators.
from src.tools import categories, delivery, orders, products  # noqa: F401, E402


# ── Routes
async def _landing(_request: Request) -> HTMLResponse:
    return HTMLResponse(_LANDING_HTML)

async def _health(_request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})

async def _stats(_request: Request) -> JSONResponse:
    return JSONResponse({"cache": cache.stats()})


# ── Chat route: interpret query and call MCP tools
async def _chat(request: Request) -> JSONResponse:
    body = await request.json()
    query = body.get("query", "").lower()

    # Product search
    if "search" in query or "find" in query:
        result = await mcp.call_tool("kapruka_search_products", {"q": query})
        return JSONResponse({"reply": result})

    # Product details by ID
    if "product" in query and "id" in query:
        pid = "".join([c for c in query if c.isalnum()])
        result = await mcp.call_tool("kapruka_get_product", {"product_id": pid})
        return JSONResponse({"reply": result})

    # Categories
    if "categories" in query or "list categories" in query:
        result = await mcp.call_tool("kapruka_list_categories", {"depth": 1})
        return JSONResponse({"reply": result})

    # Delivery cities
    if "delivery cities" in query or "where deliver" in query:
        result = await mcp.call_tool("kapruka_list_delivery_cities", {"query": ""})
        return JSONResponse({"reply": result})

    # Delivery check
    if "check delivery" in query or "deliver to" in query:
        # Example: "deliver to Colombo on 2026-06-15 product cake123"
        city_match = re.search(r"deliver to (\w+)", query)
        date_match = re.search(r"\d{4}-\d{2}-\d{2}", query)
        pid_match = re.search(r"[A-Za-z0-9_]+", query)
        city = city_match.group(1) if city_match else "Colombo"
        date = date_match.group(0) if date_match else "2026-06-15"
        pid = pid_match.group(0) if pid_match else "cake00ka002034"
        result = await mcp.call_tool("kapruka_check_delivery", {
            "city": city,
            "delivery_date": date,
            "product_id": pid
        })
        return JSONResponse({"reply": result})

    # Create order
    if "create order" in query or "place order" in query:
        result = await mcp.call_tool("kapruka_create_order", {
            "cart": [{"product_id": "cake00ka002034", "quantity": 1}],
            "recipient": {"name": "Chamodith", "city": "Colombo"},
            "delivery": {"date": "2026-06-15"},
            "sender": {"name": "Chamodith"},
            "gift_message": "Best wishes!",
            "currency": "LKR"
        })
        return JSONResponse({"reply": result})

    # Track order
    if "track order" in query:
        order_num = "".join([c for c in query if c.isdigit()])
        result = await mcp.call_tool("kapruka_track_order", {"order_number": order_num})
        return JSONResponse({"reply": result})

    # Default fallback
    return JSONResponse({"reply": f"Sorry, I didn’t understand: {query}"})


def build_app() -> Starlette:
    """Compose the MCP Starlette app with health routes, middleware, and CORS."""
    app: Starlette = mcp.streamable_http_app()

    # ── Routes
    app.router.routes.insert(0, Route("/", _landing, methods=["GET"]))
    app.router.routes.insert(1, Route("/health", _health, methods=["GET"]))
    app.router.routes.insert(2, Route("/stats", _stats, methods=["GET"]))
    app.router.routes.insert(3, Route("/chat", _chat, methods=["POST"]))
    app.router.routes.insert(4, Route("/.well-known/mcp.json", well_known_mcp, methods=["GET"]))
    app.router.routes.insert(5, Route("/.well-known/mcp.json", well_known_mcp_options, methods=["OPTIONS"]))

    # ── CORS for React frontend
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Activity logging
    if settings.activity_db_url:
        activity_log = ActivityLogger(settings.activity_db_url)
        app.add_middleware(
            ActivityLogMiddleware,
            log=activity_log,
            trusted_proxies=settings.trusted_proxies,
        )
        logger.info("Activity logging: enabled")
    else:
        logger.info("Activity logging: disabled")

    # ── Rate limiting
    if settings.rate_limit_enabled:
        app.add_middleware(
            RateLimitMiddleware,
            limit_per_minute=settings.rate_limit_per_minute,
            trusted_proxies=settings.trusted_proxies,
        )
        app.add_middleware(
            OrderRateLimitMiddleware,
            limit_per_hour=settings.order_rate_limit_per_hour,
        )
        logger.info("Rate limits enabled")
    else:
        logger.warning("Rate limit DISABLED")

    return app


def main() -> None:
    import uvicorn
    logger.info("Starting Kapruka MCP server on %s:%s", settings.mcp_host, settings.mcp_port)
    uvicorn.run(
        build_app(),
        host=settings.mcp_host,
        port=settings.mcp_port,
        log_level=settings.log_level.lower(),
        access_log=False,
        proxy_headers=True,
        forwarded_allow_ips=",".join(settings.trusted_proxies),
    )


if __name__ == "__main__":
    main()
