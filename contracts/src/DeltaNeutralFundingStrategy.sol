// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./HyperEVMInterfaces.sol";
import "./IStrategy.sol";

/**
 * @title Delta-Neutral Funding Strategy
 * @notice DUMB CONTRACT - Keeper decides everything, contract just executes
 * 
 * This contract provides primitive functions for the keeper to:
 * - Deposit/withdraw collateral to HyperLend
 * - Borrow/repay assets from HyperLend
 * - Open/close perp positions on HyperLiquid
 * - Swap USDC -> HYPE via HyperSwap V3 and bridge to HyperCore
 * 
 * The KEEPER (off-chain bot) is responsible for:
 * - Calculating optimal leverage
 * - Monitoring health factor
 * - Deciding when to rebalance
 * - Managing delta neutrality
 * - All risk management decisions
 */

// ═══════════════════════════════════════════════════════════
// HYPERSWAP V3 INTERFACES
// ═══════════════════════════════════════════════════════════

/// @notice HyperSwap V3 SwapRouter02 interface (Uniswap V3 style)
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another token
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another along the specified path
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice WHYPE (Wrapped HYPE) interface - standard WETH pattern
/// @dev WHYPE is just the ERC20 wrapper for native HYPE (like WETH for ETH)
///      HyperSwap pools use WHYPE, but we unwrap to native HYPE for bridging
interface IWHYPE {
    function deposit() external payable;
    function withdraw(uint256 amount) external;  // Unwraps WHYPE → native HYPE
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract DeltaNeutralFundingStrategy is IStrategy, Ownable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════
    
    address public constant L1_READ = 0x0000000000000000000000000000000000000800;
    address public constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    
    // HyperSwap V3 contracts (from docs.hyperswap.exchange)
    address public constant HYPERSWAP_V3_ROUTER = 0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77;
    address public constant WHYPE = 0x5555555555555555555555555555555555555555;
    
    // HYPE system address for bridging EVM -> HyperCore
    address public constant HYPE_SYSTEM_ADDRESS = 0x2222222222222222222222222222222222222222;
    
    // ═══════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════
    
    IERC20 public immutable usdc;
    address public immutable vault;
    uint32 public immutable assetId;
    
    IHyperLendPool public immutable lendingPool;
    IERC20 public immutable weth;
    
    // ═══════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════
    
    mapping(address => bool) public keepers;
    uint256 public totalPrincipal;
    
    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════
    
    event KeeperUpdated(address indexed keeper, bool active);
    event CollateralDeposited(uint256 amount);
    event CollateralWithdrawn(uint256 amount);
    event AssetBorrowed(address asset, uint256 amount);
    event AssetRepaid(address asset, uint256 amount);
    event PerpOrderPlaced(uint32 asset, bool isLong, uint64 size, uint64 price);
    event EmergencyAction(string action);

    // ═══════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════

    modifier onlyVault() {
        require(msg.sender == vault, "Only Vault");
        _;
    }

    modifier onlyKeeper() {
        require(keepers[msg.sender] || msg.sender == owner(), "Only Keeper");
        _;
    }

    // ═══════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    constructor(
        address _vault,
        address _usdc,
        address _weth,
        address _lendingPool,
        uint32 _assetId
    ) Ownable(msg.sender) {
        vault = _vault;
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
        lendingPool = IHyperLendPool(_lendingPool);
        assetId = _assetId;
    }

    // ═══════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════

    function setKeeper(address keeper, bool active) external onlyOwner {
        keepers[keeper] = active;
        emit KeeperUpdated(keeper, active);
    }

    // ═══════════════════════════════════════════════════════════
    // VAULT INTERFACE (IStrategy)
    // ═══════════════════════════════════════════════════════════

    function deposit(uint256 amount) external override onlyVault {
        require(amount > 0, "Amount > 0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
    }

    function withdraw(uint256 amount) external override onlyVault {
        // Just transfer - keeper should have prepared the funds
        usdc.safeTransfer(vault, amount);
        if (totalPrincipal >= amount) {
            totalPrincipal -= amount;
        } else {
            totalPrincipal = 0;
        }
    }

    function claimRewards(address recipient) external override returns (uint256) {
        // Keeper handles profit calculation off-chain
        // This just transfers any idle USDC above principal
        uint256 idle = usdc.balanceOf(address(this));
        if (idle > 0) {
            usdc.safeTransfer(recipient, idle);
            return idle;
        }
        return 0;
    }

    function totalAssets() external view override returns (uint256) {
        // Simple view - keeper calculates true NAV off-chain
        return _getCollateralBalance() + usdc.balanceOf(address(this));
    }

    // ═══════════════════════════════════════════════════════════
    // KEEPER FUNCTIONS - HyperLend Operations
    // ═══════════════════════════════════════════════════════════

    /// @notice Deposit USDC as collateral to HyperLend
    /// @param amount Amount of USDC to deposit
    function depositCollateral(uint256 amount) external onlyKeeper {
        usdc.approve(address(lendingPool), amount);
        lendingPool.deposit(address(usdc), amount, address(this), 0);
        emit CollateralDeposited(amount);
    }

    /// @notice Withdraw USDC collateral from HyperLend
    /// @param amount Amount to withdraw
    function withdrawCollateral(uint256 amount) external onlyKeeper {
        lendingPool.withdraw(address(usdc), amount, address(this));
        emit CollateralWithdrawn(amount);
    }

    /// @notice Borrow an asset from HyperLend
    /// @param asset Address of asset to borrow (e.g., WETH)
    /// @param amount Amount to borrow
    function borrow(address asset, uint256 amount) external onlyKeeper {
        lendingPool.borrow(asset, amount, 2, 0, address(this)); // Variable rate
        emit AssetBorrowed(asset, amount);
    }

    /// @notice Repay borrowed asset to HyperLend
    /// @param asset Address of asset to repay
    /// @param amount Amount to repay (use type(uint256).max for full repay)
    function repay(address asset, uint256 amount) external onlyKeeper {
        IERC20(asset).approve(address(lendingPool), amount);
        lendingPool.repay(asset, amount, 2, address(this));
        emit AssetRepaid(asset, amount);
    }

    // ═══════════════════════════════════════════════════════════
    // KEEPER FUNCTIONS - HyperLiquid Perp Operations
    // ═══════════════════════════════════════════════════════════

    /// @notice Place a perp order on HyperLiquid
    /// @param isLong True for long, false for short
    /// @param size Position size (1e8 scaled)
    /// @param limitPrice Limit price (1e8 scaled, 0 for market)
    /// @param reduceOnly Whether this is reduce-only
    function placePerpOrder(
        bool isLong,
        uint64 size,
        uint64 limitPrice,
        bool reduceOnly
    ) external onlyKeeper {
        bytes memory encodedAction = abi.encode(
            assetId,
            isLong,
            limitPrice,
            size,
            reduceOnly,
            uint8(3), // IOC
            uint128(0)
        );
        _sendAction(1, encodedAction);
        emit PerpOrderPlaced(assetId, isLong, size, limitPrice);
    }

    /// @notice Transfer USD between spot and perp accounts ON HYPERCORE
    /// @dev This moves funds between perp margin and spot balance on HyperCore L1
    /// @param amount Amount to transfer
    /// @param toPerp True to move to perp, false to move to spot
    function transferUSD(uint64 amount, bool toPerp) external onlyKeeper {
        bytes memory encodedAction = abi.encode(amount, toPerp);
        _sendAction(7, encodedAction);
    }

    /// @notice Bridge USDC from HyperEVM to HyperCore spot balance
    /// @dev Transfers USDC to the system address (0x2000...0000) which bridges it to L1
    /// @param amount Amount of USDC to bridge (6 decimals)
    function bridgeToCore(uint256 amount) external onlyKeeper {
        // USDC system address = 0x20 + zeros + token index 0
        address USDC_SYSTEM_ADDRESS = 0x2000000000000000000000000000000000000000;
        usdc.safeTransfer(USDC_SYSTEM_ADDRESS, amount);
        emit BridgedToCore(amount);
    }

    /// @notice Bridge USDC from HyperCore spot to HyperEVM
    /// @dev Uses spotSend action to send to this contract's address
    /// @param amount Amount to bridge back (will arrive as ERC20)
    function bridgeFromCore(uint64 amount) external onlyKeeper {
        // spotSend action to self - tokens will arrive as ERC20
        // Action format for spotSend: (token_index, destination, amount)
        // This sends from HyperCore spot to HyperEVM
        bytes memory encodedAction = abi.encode(
            uint32(0),           // USDC token index
            address(this),       // destination (this contract on EVM)
            amount
        );
        _sendAction(3, encodedAction); // Action 3 = spotSend
        emit BridgedFromCore(amount);
    }

    event BridgedToCore(uint256 amount);
    event BridgedFromCore(uint64 amount);
    event SwappedUSDCToHYPE(uint256 usdcIn, uint256 hypeOut);
    event HYPEBridgedToCore(uint256 amount);

    /// @notice Place a spot order on HyperCore (buy/sell ETH for USDC)
    /// @param isBuy True to buy ETH, false to sell ETH
    /// @param size Amount of ETH (1e8 scaled)
    /// @param limitPrice Limit price (1e8 scaled)
    function placeSpotOrder(
        bool isBuy,
        uint64 size,
        uint64 limitPrice
    ) external onlyKeeper {
        // Spot orders use Action ID 1 with spot-specific encoding
        // Format: (asset_id, is_buy, limit_px, sz, reduce_only, order_type, client_oid)
        // For spot, asset_id uses the spot token index (not perp asset id)
        // ETH spot token index is typically 1 (USDC=0, ETH=1, etc.)
        bytes memory encodedAction = abi.encode(
            uint32(1),      // ETH spot token index (TODO: make configurable)
            isBuy,
            limitPrice,
            size,
            false,          // reduceOnly = false for spot
            uint8(3),       // IOC
            uint128(0)      // client order id
        );
        _sendAction(1, encodedAction);
        emit SpotOrderPlaced(isBuy, size, limitPrice);
    }

    event SpotOrderPlaced(bool indexed isBuy, uint64 size, uint64 limitPrice);

    // ═══════════════════════════════════════════════════════════
    // KEEPER FUNCTIONS - HyperSwap V3 & HYPE Bridge
    // ═══════════════════════════════════════════════════════════

    /// @notice Swap USDC to native HYPE via HyperSwap V3
    /// @dev HyperSwap pools use WHYPE (wrapped HYPE), so we:
    ///      1. Swap USDC → WHYPE on HyperSwap V3
    ///      2. Unwrap WHYPE → native HYPE
    /// @param amountIn Amount of USDC to swap (6 decimals)
    /// @param amountOutMin Minimum HYPE to receive (slippage protection, 18 decimals)
    /// @param poolFee The pool fee tier (typically 3000 = 0.3%, 500 = 0.05%, 10000 = 1%)
    /// @return amountOut Amount of native HYPE received
    function swapUSDCToHYPE(
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 poolFee
    ) external onlyKeeper returns (uint256 amountOut) {
        require(amountIn > 0, "Amount must be > 0");
        
        // Approve router to spend USDC
        usdc.approve(HYPERSWAP_V3_ROUTER, amountIn);
        
        // Build swap params - output is WHYPE (wrapped HYPE)
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(usdc),
            tokenOut: WHYPE,  // HyperSwap pools use WHYPE
            fee: poolFee,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0 // No price limit
        });
        
        // Execute swap (receives WHYPE)
        amountOut = ISwapRouter(HYPERSWAP_V3_ROUTER).exactInputSingle(params);
        
        // Unwrap WHYPE → native HYPE (now we have native HYPE!)
        IWHYPE(WHYPE).withdraw(amountOut);
        
        emit SwappedUSDCToHYPE(amountIn, amountOut);
        return amountOut;
    }

    /// @notice Bridge native HYPE to HyperCore
    /// @dev Transfers native HYPE to system address 0x2222...2222
    ///      This is the official way to bridge HYPE from EVM to HyperCore L1
    /// @param amount Amount of native HYPE to bridge (18 decimals)
    function bridgeHYPEToCore(uint256 amount) external onlyKeeper {
        require(amount > 0, "Amount must be > 0");
        require(address(this).balance >= amount, "Insufficient HYPE balance");
        
        // Transfer native HYPE to system address (bridges to HyperCore)
        (bool success, ) = HYPE_SYSTEM_ADDRESS.call{value: amount}("");
        require(success, "HYPE bridge failed");
        
        emit HYPEBridgedToCore(amount);
    }

    /// @notice Swap USDC to native HYPE and bridge to HyperCore in one transaction
    /// @dev Complete flow: USDC → WHYPE (swap) → native HYPE (unwrap) → HyperCore (bridge)
    /// @param usdcAmount Amount of USDC to swap (6 decimals)
    /// @param minHypeOut Minimum HYPE to receive (slippage protection, 18 decimals)
    /// @param poolFee The pool fee tier
    function swapAndBridgeToCore(
        uint256 usdcAmount,
        uint256 minHypeOut,
        uint24 poolFee
    ) external onlyKeeper {
        require(usdcAmount > 0, "Amount must be > 0");
        
        // Step 1: Swap USDC → WHYPE (HyperSwap V3 pools use wrapped tokens)
        usdc.approve(HYPERSWAP_V3_ROUTER, usdcAmount);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(usdc),
            tokenOut: WHYPE,
            fee: poolFee,
            recipient: address(this),
            amountIn: usdcAmount,
            amountOutMinimum: minHypeOut,
            sqrtPriceLimitX96: 0
        });
        
        uint256 whypeReceived = ISwapRouter(HYPERSWAP_V3_ROUTER).exactInputSingle(params);
        emit SwappedUSDCToHYPE(usdcAmount, whypeReceived);
        
        // Step 2: Unwrap WHYPE → native HYPE
        IWHYPE(WHYPE).withdraw(whypeReceived);
        
        // Step 3: Bridge native HYPE to HyperCore (transfer to 0x2222...2222)
        (bool success, ) = HYPE_SYSTEM_ADDRESS.call{value: whypeReceived}("");
        require(success, "HYPE bridge failed");
        
        emit HYPEBridgedToCore(whypeReceived);
    }

    /// @notice Get WHYPE balance held by this contract
    function getWHYPEBalance() external view returns (uint256) {
        return IWHYPE(WHYPE).balanceOf(address(this));
    }

    /// @notice Get native HYPE balance held by this contract
    function getHYPEBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Sell HYPE for USDC on HyperCore spot market
    /// @dev After bridging HYPE to HyperCore, use this to convert to USDC
    /// @param size Amount of HYPE to sell (1e8 scaled)
    /// @param limitPrice Limit price for HYPE/USDC (1e8 scaled)
    function sellHYPEForUSDC(uint64 size, uint64 limitPrice) external onlyKeeper {
        // HYPE spot token index is 150 on HyperCore
        // This places a sell order for HYPE -> USDC
        bytes memory encodedAction = abi.encode(
            uint32(150),    // HYPE spot token index
            false,          // isBuy = false (selling)
            limitPrice,
            size,
            false,          // reduceOnly = false
            uint8(3),       // IOC
            uint128(0)      // client order id
        );
        _sendAction(1, encodedAction);
        emit SpotOrderPlaced(false, size, limitPrice);
    }

    /// @notice Allow contract to receive native HYPE
    receive() external payable {}

    /// @notice Close all perp positions (emergency)
    function closeAllPerpPositions() external onlyKeeper {
        IL1Read.PerpsPosition[] memory positions = IL1Read(L1_READ).readPerpPositions(address(this));
        
        for (uint i = 0; i < positions.length; i++) {
            if (positions[i].szi != 0) {
                bool isLong = positions[i].szi > 0;
                uint64 size = uint64(uint256(isLong ? positions[i].szi : -positions[i].szi));
                
                // Close with aggressive price
                uint64 limitPx = isLong ? 1 : type(uint64).max;
                
                bytes memory encodedAction = abi.encode(
                    uint32(positions[i].coin),
                    !isLong,
                    limitPx,
                    size,
                    true, // reduceOnly
                    uint8(3),
                    uint128(0)
                );
                _sendAction(1, encodedAction);
            }
        }
        emit EmergencyAction("closeAllPerpPositions");
    }

    // ═══════════════════════════════════════════════════════════
    // KEEPER FUNCTIONS - Cross-Position Rescue
    // ═══════════════════════════════════════════════════════════

    /// @notice Realize perp PnL and move to spot for HyperLend rescue
    /// @dev Closes perp position partially/fully, moves profit to spot, deposits to HyperLend
    /// @param perpSizeToClose Size of perp to close (1e8 scaled), 0 = close all
    /// @param limitPrice Limit price for closing (1e8 scaled)
    function rescueHyperLendFromPerp(uint64 perpSizeToClose, uint64 limitPrice) external onlyKeeper {
        IL1Read.PerpsPosition[] memory positions = IL1Read(L1_READ).readPerpPositions(address(this));
        
        for (uint i = 0; i < positions.length; i++) {
            if (positions[i].coin == assetId && positions[i].szi != 0) {
                bool isLong = positions[i].szi > 0;
                uint64 currentSize = uint64(uint256(isLong ? positions[i].szi : -positions[i].szi));
                
                // Determine how much to close
                uint64 closeSize = perpSizeToClose == 0 ? currentSize : perpSizeToClose;
                if (closeSize > currentSize) closeSize = currentSize;
                
                // Close position (opposite direction)
                bytes memory encodedAction = abi.encode(
                    assetId,
                    !isLong, // Opposite direction to close
                    limitPrice,
                    closeSize,
                    true, // reduceOnly
                    uint8(3), // IOC
                    uint128(0)
                );
                _sendAction(1, encodedAction);
                break;
            }
        }
        
        emit EmergencyAction("rescueHyperLendFromPerp");
    }

    /// @notice Move realized perp profits to HyperLend collateral
    /// @dev Call after closing profitable perp position
    /// @param amount Amount of USD to move from perp to HyperLend
    function movePerpProfitToCollateral(uint64 amount) external onlyKeeper {
        // 1. Transfer from perp to spot
        bytes memory transferAction = abi.encode(amount, false); // toPerp = false
        _sendAction(7, transferAction);
        
        // Note: The USDC will arrive in this contract's balance
        // Keeper should call depositCollateral() in a subsequent tx after funds arrive
        
        emit EmergencyAction("movePerpProfitToCollateral");
    }

    /// @notice Withdraw HyperLend collateral to rescue perp margin
    /// @dev Only safe if HF allows withdrawal
    /// @param amount Amount of USDC to withdraw and send to perp
    function rescuePerpFromHyperLend(uint256 amount) external onlyKeeper {
        // 1. Withdraw from HyperLend
        lendingPool.withdraw(address(usdc), amount, address(this));
        
        // 2. Transfer to perp margin
        bytes memory transferAction = abi.encode(uint64(amount), true); // toPerp = true
        _sendAction(7, transferAction);
        
        emit EmergencyAction("rescuePerpFromHyperLend");
    }

    /// @notice Atomic rescue: close perp profit, deposit to HyperLend, re-open perp
    /// @dev Complex operation - keeper should verify state before/after
    /// @param closeSize Perp size to close for profit taking
    /// @param closePrice Price to close at
    /// @param depositAmount Amount to deposit to HyperLend after closing
    /// @param reopenSize New perp size to open
    /// @param reopenPrice Price for new perp position
    /// @param reopenIsLong Direction of new position
    function rescueAndReleverage(
        uint64 closeSize,
        uint64 closePrice,
        uint256 depositAmount,
        uint64 reopenSize,
        uint64 reopenPrice,
        bool reopenIsLong
    ) external onlyKeeper {
        // Step 1: Close profitable perp position
        IL1Read.PerpsPosition[] memory positions = IL1Read(L1_READ).readPerpPositions(address(this));
        for (uint i = 0; i < positions.length; i++) {
            if (positions[i].coin == assetId && positions[i].szi != 0) {
                bool isLong = positions[i].szi > 0;
                bytes memory closeAction = abi.encode(
                    assetId,
                    !isLong,
                    closePrice,
                    closeSize,
                    true, // reduceOnly
                    uint8(3),
                    uint128(0)
                );
                _sendAction(1, closeAction);
                break;
            }
        }
        
        // Step 2: Move profit from perp to spot
        // Note: This is async on HyperCore, keeper needs to wait for settlement
        bytes memory transferAction = abi.encode(uint64(depositAmount), false);
        _sendAction(7, transferAction);
        
        // Step 3: Deposit to HyperLend (will use USDC balance after transfer settles)
        // This might fail if transfer hasn't settled - keeper should handle
        uint256 usdcBalance = usdc.balanceOf(address(this));
        if (usdcBalance >= depositAmount) {
            usdc.approve(address(lendingPool), depositAmount);
            lendingPool.deposit(address(usdc), depositAmount, address(this), 0);
        }
        
        // Step 4: Re-open perp position
        if (reopenSize > 0) {
            bytes memory openAction = abi.encode(
                assetId,
                reopenIsLong,
                reopenPrice,
                reopenSize,
                false, // not reduceOnly
                uint8(3),
                uint128(0)
            );
            _sendAction(1, openAction);
        }
        
        emit EmergencyAction("rescueAndReleverage");
    }

    // ═══════════════════════════════════════════════════════════
    // KEEPER FUNCTIONS - Emergency
    // ═══════════════════════════════════════════════════════════

    /// @notice Emergency withdraw all collateral (after closing positions)
    function emergencyWithdrawAll() external onlyKeeper {
        // Withdraw all from HyperLend
        uint256 collateral = _getCollateralBalance();
        if (collateral > 0) {
            lendingPool.withdraw(address(usdc), type(uint256).max, address(this));
        }
        
        // Transfer perp balance to spot
        uint256 perpEquity = IL1Read(L1_READ).readVaultEquity(address(this));
        if (perpEquity > 0) {
            _sendAction(7, abi.encode(uint64(perpEquity), false));
        }
        
        emit EmergencyAction("emergencyWithdrawAll");
    }

    /// @notice Rescue stuck tokens
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS - For Keeper to Read
    // ═══════════════════════════════════════════════════════════

    /// @notice Get HyperLend account data
    function getHyperLendData() external view returns (
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 availableBorrows,
        uint256 liquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    ) {
        return lendingPool.getUserAccountData(address(this));
    }

    /// @notice Get perp positions from HyperLiquid
    function getPerpPositions() external view returns (IL1Read.PerpsPosition[] memory) {
        return IL1Read(L1_READ).readPerpPositions(address(this));
    }

    /// @notice Get perp account equity
    function getPerpEquity() external view returns (uint256) {
        return IL1Read(L1_READ).readVaultEquity(address(this));
    }

    /// @notice Get oracle prices
    function getOraclePrices(uint256[] calldata assets) external view returns (uint256[] memory) {
        return IL1Read(L1_READ).readOraclePrices(assets);
    }

    /// @notice Get WETH balance (borrowed amount held)
    function getWethBalance() external view returns (uint256) {
        return weth.balanceOf(address(this));
    }

    /// @notice Get idle USDC balance
    function getIdleUSDC() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════

    function _sendAction(uint8 actionId, bytes memory encodedPayload) internal {
        bytes memory data = new bytes(4 + encodedPayload.length);
        data[0] = 0x01;
        data[1] = 0x00;
        data[2] = 0x00;
        data[3] = bytes1(actionId);
        
        for (uint256 i = 0; i < encodedPayload.length; i++) {
            data[4 + i] = encodedPayload[i];
        }
        
        ICoreWriter(CORE_WRITER).sendRawAction(data);
    }

    function _getCollateralBalance() internal view returns (uint256) {
        (uint256 totalCollateral,,,,,) = lendingPool.getUserAccountData(address(this));
        return totalCollateral;
    }
}

// ═══════════════════════════════════════════════════════════
// HYPERLEND INTERFACE
// ═══════════════════════════════════════════════════════════

interface IHyperLendPool {
    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralETH,
        uint256 totalDebtETH,
        uint256 availableBorrowsETH,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
}
