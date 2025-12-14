#!/bin/bash
# Install HyperLiquid Python SDK

echo "Installing HyperLiquid Python SDK..."

# Try to install pip if not available
if ! command -v pip3 &> /dev/null && ! python3 -m pip --version &> /dev/null; then
    echo "Installing pip..."
    python3 -m ensurepip --upgrade
fi

# Install the SDK
echo "Installing hyperliquid-python-sdk..."
python3 -m pip install hyperliquid-python-sdk

echo ""
echo "✅ Installation complete!"
echo ""
echo "Usage:"
echo "  export PRIVATE_KEY=your_private_key_here"
echo "  python3 generate_signature.py"

