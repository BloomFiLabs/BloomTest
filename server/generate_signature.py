#!/usr/bin/env python3
"""
HyperLiquid Signature Generator - Python SDK (Full SDK Usage)

This script uses the official HyperLiquid Python SDK's Exchange client
which handles ALL the complexity: signing, request formatting, etc.

Installation:
    pip install hyperliquid-python-sdk python-dotenv

Usage:
    1. Set PRIVATE_KEY in .env file
    2. Modify the order parameters below
    3. Run: python3 generate_signature.py
    4. The SDK will handle everything - just copy the output to Postman
"""

import os
import json
import sys
from pathlib import Path

# Try to load .env file
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent / '.env'
    load_dotenv(env_path)
except ImportError:
    pass

try:
    from hyperliquid.utils import constants
    from hyperliquid.exchange import Exchange
    from hyperliquid.info import Info
    from eth_account import Account
except ImportError as e:
    print("❌ Error: hyperliquid-python-sdk not installed")
    print()
    print("Installation:")
    print("  python3 -m pip install hyperliquid-python-sdk python-dotenv")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════
# ORDER CONFIGURATION - Modify these values
# ═══════════════════════════════════════════════════════════

ORDER_CONFIG = {
    "coin": "HYPE",  # Asset name
    "is_buy": True,  # True = BUY/LONG, False = SELL/SHORT
    "sz": 0.4,  # Order size
    "limit_px": 35.084,  # Limit price
    "reduce_only": False,  # True = only close positions
    # Order types available:
    # - {"limit": {"tif": "Ioc"}} - Immediate or Cancel (executes immediately or cancels)
    # - {"limit": {"tif": "Gtc"}} - Good Till Cancel (stays on order book)
    # - {"limit": {"tif": "Alo"}} - Add Liquidity Only / Post Only (maker order, gets rebate)
    # - {"market": {}} - Market order (executes at best available price)
    "order_type": {"limit": {"tif": "Ioc"}},  # IOC - executes immediately or cancels, requires less margin
    "vault_address": None,  # Sub-account address (None for main account)
}

# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════

def main():
    print("╔══════════════════════════════════════════════════════════╗")
    print("║   HYPERLIQUID SIGNATURE GENERATOR (FULL SDK)            ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print()

    # Get private key
    private_key = os.getenv("PRIVATE_KEY")
    if not private_key:
        raise ValueError("PRIVATE_KEY environment variable not set")
    
    # Remove 0x prefix if present
    if private_key.startswith("0x"):
        private_key = private_key[2:]
    
    # Create wallet from private key
    wallet = Account.from_key("0x" + private_key)
    wallet_address = wallet.address
    
    print(f"✅ Wallet address: {wallet_address}")
    print()

    # Initialize SDK clients - let the SDK do ALL the work
    print("📡 Initializing HyperLiquid SDK...")
    info = Info(constants.MAINNET_API_URL, skip_ws=True)
    exchange = Exchange(wallet, constants.MAINNET_API_URL, vault_address=ORDER_CONFIG["vault_address"])
    print("✅ SDK initialized")
    print()
    
    # Check account state and margin mode
    print("💰 Checking Account State...")
    try:
        user_state = info.user_state(wallet_address)
        margin_summary = user_state.get("marginSummary", {})
        account_value = float(margin_summary.get("accountValue", 0))
        margin_used = float(margin_summary.get("totalMarginUsed", 0))
        free_collateral = account_value - margin_used
        
        print(f"   Account Value: ${account_value:.2f}")
        print(f"   Margin Used: ${margin_used:.2f}")
        print(f"   Free Collateral: ${free_collateral:.2f}")
        
        # Check if using cross margin (crossMarginSummary exists and has data)
        cross_margin = user_state.get("crossMarginSummary", {})
        if cross_margin:
            print(f"   Margin Mode: CROSS MARGIN")
            print(f"   Cross Margin Value: ${float(cross_margin.get('accountValue', 0)):.2f}")
        else:
            print(f"   Margin Mode: ISOLATED MARGIN (or no positions)")
        print()
    except Exception as e:
        print(f"   ⚠️  Could not check account state: {e}")
        print()

    # Get asset ID
    print("🔍 Getting Asset ID...")
    meta = info.meta()
    if not meta:
        raise ValueError("Failed to get meta from HyperLiquid")
    
    asset_id = None
    for idx, asset in enumerate(meta["universe"]):
        if asset["name"] == ORDER_CONFIG["coin"]:
            asset_id = idx
            break
    
    if asset_id is None:
        raise ValueError(f"Asset {ORDER_CONFIG['coin']} not found in universe")
    
    print(f"   Asset: {ORDER_CONFIG['coin']} (Asset ID: {asset_id})")
    print()

    # Build order - SDK format
    order = {
        "a": asset_id,
        "b": ORDER_CONFIG["is_buy"],
        "p": str(ORDER_CONFIG["limit_px"]),
        "s": str(ORDER_CONFIG["sz"]),
        "r": ORDER_CONFIG["reduce_only"],
        "t": ORDER_CONFIG["order_type"],
    }

    print("📋 Order Details:")
    print(f"   {json.dumps(order, indent=2)}")
    print()
    
    # Show order type info
    order_type_str = json.dumps(ORDER_CONFIG["order_type"])
    print(f"📌 Order Type: {order_type_str}")
    if ORDER_CONFIG["order_type"].get("limit", {}).get("tif") == "Ioc":
        print("   → IOC: Executes immediately or cancels (requires less margin)")
    elif ORDER_CONFIG["order_type"].get("limit", {}).get("tif") == "Gtc":
        print("   → GTC: Stays on order book until filled or canceled (requires more margin)")
    elif ORDER_CONFIG["order_type"].get("limit", {}).get("tif") == "Alo":
        print("   → ALO: Post Only - adds liquidity, gets maker rebate (requires less margin)")
    elif ORDER_CONFIG["order_type"].get("market"):
        print("   → Market: Executes at best available price immediately")
    print()

    # Let the SDK handle everything - it will sign and format the request correctly
    print("🔐 SDK is handling signing and request formatting...")
    print("   (The SDK handles: msgpack encoding, EIP-712 signing, field ordering, etc.)")
    print()

    # Use the SDK's order method - it does EVERYTHING
    # This internally calls sign_l1_action with the correct parameters
    result = exchange.order(
        ORDER_CONFIG["coin"],
        ORDER_CONFIG["is_buy"],
        ORDER_CONFIG["sz"],
        ORDER_CONFIG["limit_px"],
        ORDER_CONFIG["order_type"],
        reduce_only=ORDER_CONFIG["reduce_only"]
    )

    print("═══════════════════════════════════════════════════════════")
    print("📤 SDK RESPONSE:")
    print("═══════════════════════════════════════════════════════════")
    print(json.dumps(result, indent=2))
    print()

    if result.get("status") == "ok":
        print("✅ ORDER PLACED SUCCESSFULLY!")
        if "response" in result and "data" in result["response"]:
            statuses = result["response"]["data"].get("statuses", [])
            for i, status in enumerate(statuses):
                if "resting" in status:
                    print(f"   Order {i}: Resting (Order ID: {status['resting'].get('oid', 'N/A')})")
                elif "filled" in status:
                    print(f"   Order {i}: Filled!")
                elif "error" in status:
                    print(f"   Order {i}: Error - {status['error']}")
    else:
        print("❌ ORDER FAILED")
        print(f"   Response: {result.get('response', 'Unknown error')}")

    print()
    print("💡 Note: The SDK handled all the complexity automatically!")
    print("   No manual signature generation needed.")

if __name__ == "__main__":
    main()
