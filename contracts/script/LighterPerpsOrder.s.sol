// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/interfaces/ILighterPerps.sol";

// Import gateway interface
import {ILighterGateway} from "../src/interfaces/ILighterPerps.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/**
 * @title LighterPerpsOrder
 * @notice Forge script to place perpetual futures orders on Lighter Protocol
 * 
 * Lighter Protocol: https://lighter.xyz/
 * Ethereum Gateway: https://app.lighter.xyz/ethereum-gateway/
 * 
 * Required environment variables:
 *   PRIVATE_KEY - Your private key for signing transactions
 *   RPC_URL - Ethereum RPC URL (optional, can use --rpc-url flag)
 * 
 * Optional environment variables:
 *   LIGHTER_PERPS_CONTRACT - Lighter perps contract address
 *   LIGHTER_GATEWAY_CONTRACT - Lighter gateway contract address
 *   COLLATERAL_TOKEN - Collateral token address (e.g., USDC)
 *   MARKET_ID - Market ID (e.g., 0 for ETH/USDC)
 * 
 * Usage:
 *   # Place a limit order
 *   forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
 *     --sig "placeLimitOrder(uint256,uint256,uint256,bool,uint256)" \
 *     <marketId> <size> <price> <isBuy> <leverage> \
 *     --rpc-url $RPC_URL --broadcast
 * 
 *   # Place a market order (close position)
 *   forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
 *     --sig "closePosition(uint256,uint256,bool)" \
 *     <marketId> <size> <isBuy> \
 *     --rpc-url $RPC_URL --broadcast
 * 
 *   # Check position
 *   forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
 *     --sig "checkPosition(uint256)" <marketId> \
 *     --rpc-url $RPC_URL
 * 
 *   # Deposit collateral
 *   forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
 *     --sig "depositCollateral(address,uint256)" <token> <amount> \
 *     --rpc-url $RPC_URL --broadcast
 */
contract LighterPerpsOrder is Script {
    // ═══════════════════════════════════════════════════════════
    // CONTRACT ADDRESSES - Update with actual Lighter addresses
    // ═══════════════════════════════════════════════════════════
    
    // Lighter Perpetual Futures Contract
    // Address: 0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7
    // Can be overridden via env var LIGHTER_PERPS_CONTRACT
    function getLighterPerps() internal view returns (address) {
        return vm.envOr("LIGHTER_PERPS_CONTRACT", address(0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7));
    }
    
    // Lighter Gateway Contract (Ethereum Gateway)
    // TODO: Update with actual gateway address
    // Default: 0x0000000000000000000000000000000000000000 (set via env var LIGHTER_GATEWAY_CONTRACT)
    function getLighterGateway() internal view returns (address) {
        return vm.envOr("LIGHTER_GATEWAY_CONTRACT", address(0x0000000000000000000000000000000000000000));
    }
    
    // Common token addresses (Ethereum Mainnet)
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    
    // Default market IDs (update based on Lighter's market structure)
    uint256 public constant MARKET_ETH_USDC = 0; // Example: ETH/USDC market ID
    
    // ═══════════════════════════════════════════════════════════
    // MAIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════
    
    /**
     * @notice Default run function - shows usage
     */
    function run() external view {
        console.log("=== Lighter Perpetual Futures Order Script ===");
        console.log("");
        console.log("Lighter Perps Contract:", getLighterPerps());
        console.log("Lighter Gateway Contract:", getLighterGateway());
        console.log("");
        console.log("Usage examples:");
        console.log("  forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \\");
        console.log("    --sig 'placeLimitOrder(uint256,uint256,uint256,bool,uint256)' \\");
        console.log("    0 1000000000000000000 2000000000 true 10 \\");
        console.log("    --rpc-url $RPC_URL --broadcast");
        console.log("");
        console.log("  forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \\");
        console.log("    --sig 'checkPosition(uint256)' 0 \\");
        console.log("    --rpc-url $RPC_URL");
        console.log("");
    }
    
    /**
     * @notice Place a limit order on Lighter perps
     * @param marketId Market ID (e.g., 0 for ETH/USDC)
     * @param size Order size (in base asset units, e.g., 1e18 for 1 ETH)
     * @param price Limit price (in quote asset units, e.g., 2000e6 for $2000 USDC)
     * @param isBuy true for long/buy, false for short/sell
     * @param leverage Leverage multiplier (e.g., 10 for 10x)
     */
    function placeLimitOrder(
        uint256 marketId,
        uint256 size,
        uint256 price,
        bool isBuy,
        uint256 leverage
    ) external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("=== Placing Limit Order on Lighter ===");
        console.log("Deployer:", deployer);
        console.log("Market ID:", marketId);
        console.log("Size:", size);
        console.log("Price:", price);
        console.log("Side:", isBuy ? "BUY/LONG" : "SELL/SHORT");
        console.log("Leverage:", leverage, "x");
        console.log("");
        
        address lighterPerpsAddr = getLighterPerps();
        require(lighterPerpsAddr != address(0), "LIGHTER_PERPS contract not set");
        
        vm.startBroadcast(deployerPrivateKey);
        
        ILighterPerps lighterPerps = ILighterPerps(lighterPerpsAddr);
        
        // Place the order
        console.log("Placing order...");
        uint256 orderId = lighterPerps.placeOrder(marketId, size, price, isBuy, leverage);
        
        console.log("[SUCCESS] Order placed successfully!");
        console.log("Order ID:", orderId);
        
        // Get order details
        try lighterPerps.getOrder(orderId) returns (
            uint256 _marketId,
            uint256 _size,
            uint256 _price,
            bool _isBuy,
            uint256 _leverage,
            uint256 _filled,
            uint8 _status
        ) {
            console.log("");
            console.log("Order Details:");
            console.log("  Market ID:", _marketId);
            console.log("  Size:", _size);
            console.log("  Price:", _price);
            console.log("  Side:", _isBuy ? "BUY" : "SELL");
            console.log("  Leverage:", _leverage, "x");
            console.log("  Filled:", _filled);
            console.log("  Status:", _status == 0 ? "Pending" : _status == 1 ? "Filled" : "Cancelled");
        } catch {
            console.log("(Could not fetch order details)");
        }
        
        vm.stopBroadcast();
    }
    
    /**
     * @notice Close a position (market order)
     * @param marketId Market ID
     * @param size Size to close (absolute value)
     * @param isBuy true to close long position, false to close short position
     */
    function closePosition(
        uint256 marketId,
        uint256 size,
        bool isBuy
    ) external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("=== Closing Position on Lighter ===");
        console.log("Deployer:", deployer);
        console.log("Market ID:", marketId);
        console.log("Size:", size);
        console.log("Closing:", isBuy ? "LONG" : "SHORT");
        console.log("");
        
        address lighterPerpsAddr = getLighterPerps();
        require(lighterPerpsAddr != address(0), "LIGHTER_PERPS contract not set");
        
        vm.startBroadcast(deployerPrivateKey);
        
        ILighterPerps lighterPerps = ILighterPerps(lighterPerpsAddr);
        
        console.log("Closing position...");
        lighterPerps.closePosition(marketId, size, isBuy);
        
        console.log("[SUCCESS] Position closed successfully!");
        
        vm.stopBroadcast();
    }
    
    /**
     * @notice Cancel an order
     * @param orderId Order ID to cancel
     */
    function cancelOrder(uint256 orderId) external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("=== Cancelling Order ===");
        console.log("Deployer:", deployer);
        console.log("Order ID:", orderId);
        console.log("");
        
        address lighterPerpsAddr = getLighterPerps();
        require(lighterPerpsAddr != address(0), "LIGHTER_PERPS contract not set");
        
        vm.startBroadcast(deployerPrivateKey);
        
        ILighterPerps lighterPerps = ILighterPerps(lighterPerpsAddr);
        
        console.log("Cancelling order...");
        lighterPerps.cancelOrder(orderId);
        
        console.log("[SUCCESS] Order cancelled successfully!");
        
        vm.stopBroadcast();
    }
    
    /**
     * @notice Check user's position for a market
     * @param marketId Market ID
     */
    function checkPosition(uint256 marketId) external view {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("=== Checking Position ===");
        console.log("User:", deployer);
        console.log("Market ID:", marketId);
        console.log("");
        
        address lighterPerpsAddr = getLighterPerps();
        require(lighterPerpsAddr != address(0), "LIGHTER_PERPS contract not set");
        
        ILighterPerps lighterPerps = ILighterPerps(lighterPerpsAddr);
        
        try lighterPerps.getPosition(deployer, marketId) returns (
            int256 size,
            uint256 entryPrice,
            uint256 margin,
            int256 unrealizedPnl
        ) {
            console.log("Position Details:");
            console.log("  Size:", size > 0 ? "LONG" : size < 0 ? "SHORT" : "NONE", uint256(size > 0 ? size : -size));
            console.log("  Entry Price:", entryPrice);
            console.log("  Margin:", margin);
            console.log("  Unrealized PnL:", unrealizedPnl);
        } catch {
            console.log("(Could not fetch position - may not exist)");
        }
    }
    
    /**
     * @notice Deposit collateral to Lighter Gateway
     * @param token Token address (e.g., USDC)
     * @param amount Amount to deposit (in token decimals, e.g., 1e6 for 1 USDC)
     */
    function depositCollateral(address token, uint256 amount) external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("=== Depositing Collateral to Lighter Gateway ===");
        console.log("Deployer:", deployer);
        console.log("Token:", token);
        console.log("Amount:", amount);
        console.log("");
        
        address gatewayAddr = getLighterGateway();
        require(gatewayAddr != address(0), "LIGHTER_GATEWAY contract not set");
        
        vm.startBroadcast(deployerPrivateKey);
        
        IERC20 tokenContract = IERC20(token);
        ILighterGateway gateway = ILighterGateway(gatewayAddr);
        
        // Check balance
        uint256 balance = tokenContract.balanceOf(deployer);
        console.log("Wallet balance:", balance);
        require(balance >= amount, "Insufficient balance");
        
        // Approve gateway to spend tokens
        console.log("Approving gateway to spend tokens...");
        tokenContract.approve(gatewayAddr, amount);
        
        // Deposit
        console.log("Depositing to gateway...");
        gateway.deposit(token, amount);
        
        console.log("[SUCCESS] Collateral deposited successfully!");
        
        // Check new balance in gateway
        uint256 gatewayBalance = gateway.getBalance(deployer, token);
        console.log("Gateway balance:", gatewayBalance);
        
        vm.stopBroadcast();
    }
    
    /**
     * @notice Withdraw collateral from Lighter Gateway
     * @param token Token address
     * @param amount Amount to withdraw
     */
    function withdrawCollateral(address token, uint256 amount) external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("=== Withdrawing Collateral from Lighter Gateway ===");
        console.log("Deployer:", deployer);
        console.log("Token:", token);
        console.log("Amount:", amount);
        console.log("");
        
        address gatewayAddr = getLighterGateway();
        require(gatewayAddr != address(0), "LIGHTER_GATEWAY contract not set");
        
        vm.startBroadcast(deployerPrivateKey);
        
        ILighterGateway gateway = ILighterGateway(gatewayAddr);
        
        // Check gateway balance
        uint256 gatewayBalance = gateway.getBalance(deployer, token);
        console.log("Gateway balance:", gatewayBalance);
        require(gatewayBalance >= amount, "Insufficient gateway balance");
        
        // Withdraw
        console.log("Withdrawing from gateway...");
        gateway.withdraw(token, amount);
        
        console.log("[SUCCESS] Collateral withdrawn successfully!");
        
        vm.stopBroadcast();
    }
    
    /**
     * @notice Check gateway balance
     * @param token Token address
     */
    function checkGatewayBalance(address token) external view {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("=== Gateway Balance ===");
        console.log("User:", deployer);
        console.log("Token:", token);
        console.log("");
        
        address gatewayAddr = getLighterGateway();
        require(gatewayAddr != address(0), "LIGHTER_GATEWAY contract not set");
        
        ILighterGateway gateway = ILighterGateway(gatewayAddr);
        uint256 balance = gateway.getBalance(deployer, token);
        
        console.log("Gateway Balance:", balance);
    }
}

