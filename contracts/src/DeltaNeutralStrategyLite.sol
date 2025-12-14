// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IStrategy.sol";

/// @title Delta-Neutral Funding Strategy (Optimized)
/// @notice Keeper-controlled strategy for delta-neutral funding rate capture
contract DeltaNeutralStrategyLite is IStrategy, Ownable {
    using SafeERC20 for IERC20;

    // Constants
    address constant L1_READ = 0x0000000000000000000000000000000000000800;
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address constant HYPERSWAP_ROUTER = 0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77;
    address constant WHYPE = 0x5555555555555555555555555555555555555555;
    address constant HYPE_BRIDGE = 0x2222222222222222222222222222222222222222;

    // Immutables
    IERC20 public immutable usdc;
    IERC20 public immutable weth;
    IPool public immutable pool;
    address public immutable vault;
    uint32 public immutable assetId;

    // State
    mapping(address => bool) public keepers;
    uint256 public totalPrincipal;
    address public keeperAddress; // Primary keeper for receiving funds

    // Events
    event Deposit(uint256 amount);
    event Withdraw(uint256 amount);
    event KeeperSet(address indexed k, bool active);
    event Action(string name);

    modifier onlyVault() { require(msg.sender == vault, "!vault"); _; }
    modifier onlyKeeper() { require(keepers[msg.sender] || msg.sender == owner(), "!keeper"); _; }

    constructor(address _vault, address _usdc, address _weth, address _pool, uint32 _assetId) Ownable(msg.sender) {
        vault = _vault;
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
        pool = IPool(_pool);
        assetId = _assetId;
    }

    function setKeeper(address k, bool active) external onlyOwner { 
        keepers[k] = active; 
        if (active && keeperAddress == address(0)) {
            keeperAddress = k; // Set first keeper as primary
        }
        emit KeeperSet(k, active); 
    }
    
    function setKeeperAddress(address k) external onlyOwner {
        require(keepers[k], "!keeper");
        keeperAddress = k;
    }
    
    function getKeeperAddress() external view returns (address) {
        return keeperAddress;
    }

    // === VAULT INTERFACE ===
    function deposit(uint256 amt) external override onlyVault {
        require(amt > 0, "!amt");
        usdc.safeTransferFrom(msg.sender, address(this), amt);
        totalPrincipal += amt;
        emit Deposit(amt);
    }

    function withdraw(uint256 amt) external override onlyVault {
        usdc.safeTransfer(vault, amt);
        totalPrincipal = totalPrincipal > amt ? totalPrincipal - amt : 0;
        emit Withdraw(amt);
    }

    function claimRewards(address to) external override returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal > 0) usdc.safeTransfer(to, bal);
        return bal;
    }

    function totalAssets() external view override returns (uint256) {
        return _collateral() + usdc.balanceOf(address(this));
    }

    // === HYPERLEND ===
    function depositCollateral(uint256 amt) external onlyKeeper {
        usdc.approve(address(pool), amt);
        pool.deposit(address(usdc), amt, address(this), 0);
    }

    function withdrawCollateral(uint256 amt) external onlyKeeper {
        pool.withdraw(address(usdc), amt, address(this));
    }

    function borrow(address asset, uint256 amt) external onlyKeeper {
        pool.borrow(asset, amt, 2, 0, address(this));
    }

    function repay(address asset, uint256 amt) external onlyKeeper {
        IERC20(asset).approve(address(pool), amt);
        pool.repay(asset, amt, 2, address(this));
    }

    // === PERPS ===
    function perpOrder(bool isLong, uint64 sz, uint64 px, bool reduceOnly) external onlyKeeper {
        _send(1, abi.encode(assetId, isLong, px, sz, reduceOnly, uint8(3), uint128(0)));
    }

    function transferUSD(uint64 amt, bool toPerp) external onlyKeeper {
        _send(7, abi.encode(amt, toPerp));
    }

    /// @notice Place a spot order on HyperCore
    /// @dev Asset ID for spot = pair_index + 10000 (e.g., HYPE/USDC pair 107 = asset 10107)
    /// @param spotAsset The spot asset ID (pair index + 10000)
    /// @param isBuy True to buy base asset, false to sell
    /// @param sz Size in base asset units (10^8 scaled)
    /// @param px Limit price (10^8 scaled)
    function spotOrder(uint32 spotAsset, bool isBuy, uint64 sz, uint64 px) external onlyKeeper {
        // Action 1 = Limit Order: (asset, isBuy, limitPx, sz, reduceOnly, tif, cloid)
        // Tif: 1=Alo, 2=Gtc, 3=Ioc
        _send(1, abi.encode(spotAsset, isBuy, px, sz, false, uint8(3), uint128(0)));
    }
    
    /// @notice Sell HYPE for USDC on HyperCore spot
    /// @dev HYPE/USDC pair index is 107, so spot asset = 10107
    /// @param sz Amount of HYPE to sell (10^8 scaled, e.g., 0.26 HYPE = 26000000)
    /// @param px Limit price for HYPE/USDC (10^8 scaled)
    /// @param tif Time-in-force: 1=Alo, 2=Gtc, 3=Ioc
    function sellHYPE(uint64 sz, uint64 px, uint8 tif) external onlyKeeper {
        // HYPE/USDC spot asset ID = 107 + 10000 = 10107
        _send(1, abi.encode(uint32(10107), false, px, sz, false, tif, uint128(0)));
    }

    // === BRIDGE FLOW (Legacy - kept for future use) ===
    /// @notice Swap USDC to HYPE and bridge to HyperCore (contract's account)
    /// @dev This bridges to the CONTRACT's HyperCore account. CoreWriter orders don't work from contracts.
    function swapAndBridge(uint256 usdcAmt, uint256 minHype, uint24 fee) external onlyKeeper {
        usdc.approve(HYPERSWAP_ROUTER, usdcAmt);
        uint256 out = IRouter(HYPERSWAP_ROUTER).exactInputSingle(IRouter.Params({
            tokenIn: address(usdc), tokenOut: WHYPE, fee: fee,
            recipient: address(this), amountIn: usdcAmt, amountOutMinimum: minHype, sqrtPriceLimitX96: 0
        }));
        IWHYPE(WHYPE).withdraw(out);
        (bool ok,) = HYPE_BRIDGE.call{value: out}("");
        require(ok, "bridge");
        emit Action("swapAndBridge");
    }
    
    // === SEND TO KEEPER (Primary flow) ===
    /// @notice Swap USDC to HYPE and send native HYPE to keeper EOA
    /// @dev Keeper can then bridge HYPE to their own HyperCore account and trade via API
    /// @param usdcAmt Amount of USDC to swap (6 decimals)
    /// @param minHype Minimum HYPE to receive (18 decimals)
    /// @param fee HyperSwap pool fee tier (e.g., 3000 for 0.3%)
    function swapAndSendToKeeper(uint256 usdcAmt, uint256 minHype, uint24 fee) external onlyKeeper {
        require(keeperAddress != address(0), "!keeper");
        
        // Swap USDC -> WHYPE
        usdc.approve(HYPERSWAP_ROUTER, usdcAmt);
        uint256 out = IRouter(HYPERSWAP_ROUTER).exactInputSingle(IRouter.Params({
            tokenIn: address(usdc), tokenOut: WHYPE, fee: fee,
            recipient: address(this), amountIn: usdcAmt, amountOutMinimum: minHype, sqrtPriceLimitX96: 0
        }));
        
        // Unwrap WHYPE -> native HYPE
        IWHYPE(WHYPE).withdraw(out);
        
        // Send native HYPE to keeper
        (bool ok,) = keeperAddress.call{value: out}("");
        require(ok, "send");
        emit Action("swapAndSendToKeeper");
    }
    
    /// @notice Send native HYPE from contract to keeper
    /// @param amount Amount of native HYPE to send (18 decimals)
    function sendHypeToKeeper(uint256 amount) external onlyKeeper {
        require(keeperAddress != address(0), "!keeper");
        require(address(this).balance >= amount, "!bal");
        (bool ok,) = keeperAddress.call{value: amount}("");
        require(ok, "send");
        emit Action("sendHypeToKeeper");
    }

    // === EMERGENCY ===
    function closeAllPerps() external onlyKeeper {
        IL1.Pos[] memory pos = IL1(L1_READ).readPerpPositions(address(this));
        for (uint i = 0; i < pos.length; i++) {
            if (pos[i].szi != 0) {
                bool isLong = pos[i].szi > 0;
                int64 rawSz = isLong ? pos[i].szi : -pos[i].szi;
                uint64 sz = uint64(rawSz < 0 ? uint64(0) : uint64(int64(rawSz)));
                _send(1, abi.encode(uint32(pos[i].coin), !isLong, isLong ? uint64(1) : type(uint64).max, sz, true, uint8(3), uint128(0)));
            }
        }
    }

    function rescueTokens(address t, uint256 amt) external onlyOwner { IERC20(t).safeTransfer(owner(), amt); }
    function rescueHYPE() external onlyOwner { payable(owner()).transfer(address(this).balance); }
    
    /// @notice Authorize an API wallet (keeper) to trade on behalf of this contract on HyperCore
    /// @dev Action 9: Add API wallet - allows keeper to place orders via HyperLiquid API
    /// @param apiWallet The address of the keeper/agent wallet to authorize
    /// @param name Name for the API wallet (empty string = main agent)
    function addApiWallet(address apiWallet, string calldata name) external onlyOwner {
        // Action 9: Add API wallet (address, string)
        _send(9, abi.encode(apiWallet, name));
        emit Action("addApiWallet");
    }
    
    /// @notice Send spot assets from contract's HyperCore account to another address
    /// @dev Action 6: Spot send (destination, token, wei)
    /// @param destination The recipient address on HyperCore
    /// @param token The token index (e.g., 150 for HYPE, 0 for USDC)
    /// @param amount Amount in wei (10^8 for HYPE)
    function spotSend(address destination, uint64 token, uint64 amount) external onlyKeeper {
        // Action 6: Spot send (destination, token, wei)
        _send(6, abi.encode(destination, token, amount));
        emit Action("spotSend");
    }

    // === VIEWS ===
    function getLendData() external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return pool.getUserAccountData(address(this));
    }
    function getPerps() external view returns (IL1.Pos[] memory) { return IL1(L1_READ).readPerpPositions(address(this)); }
    function getPerpEquity() external view returns (uint256) { return IL1(L1_READ).readVaultEquity(address(this)); }
    function getWethBal() external view returns (uint256) { return weth.balanceOf(address(this)); }
    function getUsdcBal() external view returns (uint256) { return usdc.balanceOf(address(this)); }
    function getHypeBal() external view returns (uint256) { return address(this).balance; }

    // === INTERNAL ===
    function _send(uint8 id, bytes memory payload) internal {
        bytes memory d = new bytes(4 + payload.length);
        d[0] = 0x01; d[3] = bytes1(id);
        for (uint i = 0; i < payload.length; i++) d[4+i] = payload[i];
        ICoreWriter(CORE_WRITER).sendRawAction(d);
    }

    function _collateral() internal view returns (uint256 c) { (c,,,,,) = pool.getUserAccountData(address(this)); }

    receive() external payable {}
}

// Minimal interfaces
interface IPool {
    function deposit(address, uint256, address, uint16) external;
    function withdraw(address, uint256, address) external returns (uint256);
    function borrow(address, uint256, uint256, uint16, address) external;
    function repay(address, uint256, uint256, address) external returns (uint256);
    function getUserAccountData(address) external view returns (uint256,uint256,uint256,uint256,uint256,uint256);
}

interface IRouter {
    struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(Params calldata) external payable returns (uint256);
}

interface IWHYPE { function withdraw(uint256) external; }

interface ICoreWriter { function sendRawAction(bytes calldata) external; }

interface IL1 {
    struct Pos { uint32 coin; int64 szi; int64 entryPx; }
    function readPerpPositions(address) external view returns (Pos[] memory);
    function readVaultEquity(address) external view returns (uint256);
}

