// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IStrategy.sol";

/// @title Leveraged HyperSwap V3 Strategy (Lite)
/// @notice Optimized for gas - uses external LP manager
contract LeveragedStrategyLite is IStrategy, Ownable {
    using SafeERC20 for IERC20;

    // Constants
    address constant L1_READ = 0x0000000000000000000000000000000000000800;
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

    // Health factor thresholds (1e4 scale)
    uint256 public constant TARGET_HF = 20000;       // 2.0
    uint256 public constant TRIM_THRESHOLD = 15000;  // 1.5
    uint256 public constant DELEVER_THRESHOLD = 13000; // 1.3
    uint256 public constant EMERGENCY_THRESHOLD = 11500; // 1.15

    // Immutables
    IERC20 public immutable usdc;
    IPool public immutable lendingPool;
    address public immutable vault;
    uint32 public immutable perpAssetId;

    // Constants for swaps
    address constant HYPERSWAP_ROUTER = 0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77;
    address constant WHYPE = 0x5555555555555555555555555555555555555555;

    // State
    mapping(address => bool) public keepers;
    address public keeperAddress;  // Primary keeper for receiving funds
    uint256 public totalPrincipal;
    uint256 public targetLeverage;
    uint256 public maxLeverage;

    // External LP manager (optional)
    address public lpManager;
    uint256 public lpTokenId;

    // Events
    event Deposit(uint256 amount);
    event Withdraw(uint256 amount);
    event KeeperSet(address indexed k, bool active);
    event KeeperFunded(address keeper, uint256 amount, string token);
    event EarningsTrimmed(string source, uint256 amount);
    event Deleveraged(uint256 repaid, uint256 newHF);
    event LeveragedUp(uint256 borrowed, uint256 newLev);
    event EmergencyExit(uint256 returned);
    event HedgeAdjusted(int64 size);

    modifier onlyVault() { require(msg.sender == vault, "!vault"); _; }
    modifier onlyKeeper() { require(keepers[msg.sender] || msg.sender == owner(), "!keeper"); _; }

    constructor(
        address _vault,
        address _usdc,
        address _lendingPool,
        uint32 _perpAssetId
    ) Ownable(msg.sender) {
        vault = _vault;
        usdc = IERC20(_usdc);
        lendingPool = IPool(_lendingPool);
        perpAssetId = _perpAssetId;
        targetLeverage = 20000;
        maxLeverage = 30000;
    }

    // Admin
    function setKeeper(address k, bool active) external onlyOwner { 
        keepers[k] = active; 
        if (active && keeperAddress == address(0)) keeperAddress = k;
        emit KeeperSet(k, active); 
    }
    function setKeeperAddress(address k) external onlyOwner { require(keepers[k], "!keeper"); keeperAddress = k; }
    function setLeverageParams(uint256 _target, uint256 _max) external onlyOwner { targetLeverage = _target; maxLeverage = _max; }
    function setLPManager(address _lpm) external onlyOwner { lpManager = _lpm; }
    function setLPTokenId(uint256 _id) external onlyKeeper { lpTokenId = _id; }

    // === KEEPER FUNDING ===
    /// @notice Send USDC from strategy to keeper for gas/operations
    function sendUsdcToKeeper(uint256 amount) external onlyKeeper {
        require(keeperAddress != address(0), "!keeper");
        usdc.safeTransfer(keeperAddress, amount);
        emit KeeperFunded(keeperAddress, amount, "USDC");
    }

    /// @notice Swap USDC to HYPE and send to keeper
    function swapAndSendToKeeper(uint256 usdcAmt, uint256 minHype, uint24 fee) external onlyKeeper {
        require(keeperAddress != address(0), "!keeper");
        usdc.approve(HYPERSWAP_ROUTER, usdcAmt);
        uint256 out = IRouter(HYPERSWAP_ROUTER).exactInputSingle(IRouter.Params({
            tokenIn: address(usdc), tokenOut: WHYPE, fee: fee,
            recipient: address(this), amountIn: usdcAmt, amountOutMinimum: minHype, sqrtPriceLimitX96: 0
        }));
        IWHYPE(WHYPE).withdraw(out);
        (bool ok,) = keeperAddress.call{value: out}("");
        require(ok, "send");
        emit KeeperFunded(keeperAddress, out, "HYPE");
    }
    
    /// @notice Send native HYPE from contract to keeper
    function sendHypeToKeeper(uint256 amount) external onlyKeeper {
        require(keeperAddress != address(0), "!keeper");
        require(address(this).balance >= amount, "!bal");
        (bool ok,) = keeperAddress.call{value: amount}("");
        require(ok, "send");
        emit KeeperFunded(keeperAddress, amount, "HYPE");
    }

    // IStrategy - MODIFIED FOR DIRECT DEPOSIT
    function deposit(uint256 amt) external override {
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
        if (bal > totalPrincipal) {
            uint256 rewards = bal - totalPrincipal;
            usdc.safeTransfer(to, rewards);
            return rewards;
        }
        return 0;
    }

    function totalAssets() external view override returns (uint256) {
        (uint256 col, , , , , ) = lendingPool.getUserAccountData(address(this));
        return col + usdc.balanceOf(address(this)) + IL1(L1_READ).readVaultEquity(address(this));
    }

    // HyperLend
    function depositCollateral(uint256 amt) external onlyKeeper {
        usdc.approve(address(lendingPool), amt);
        lendingPool.deposit(address(usdc), amt, address(this), 0);
    }

    function withdrawCollateral(uint256 amt) external onlyKeeper {
        lendingPool.withdraw(address(usdc), amt, address(this));
    }

    function borrow(uint256 amt) external onlyKeeper {
        lendingPool.borrow(address(usdc), amt, 2, 0, address(this));
    }

    function repay(uint256 amt) external onlyKeeper {
        usdc.approve(address(lendingPool), amt);
        lendingPool.repay(address(usdc), amt, 2, address(this));
    }

    // Perps
    function adjustHedge(bool isLong, uint64 sz, uint64 px) external onlyKeeper {
        _send(1, abi.encode(perpAssetId, isLong, px, sz, false, uint8(3), uint128(0)));
        emit HedgeAdjusted(isLong ? int64(sz) : -int64(sz));
    }

    function transferUSD(uint64 amt, bool toPerp) external onlyKeeper {
        _send(7, abi.encode(amt, toPerp));
    }

    function closeAllPerps() external onlyKeeper {
        IL1.Pos[] memory pos = IL1(L1_READ).readPerpPositions(address(this));
        for (uint i = 0; i < pos.length; i++) {
            if (pos[i].szi != 0) {
                bool isLong = pos[i].szi > 0;
                uint64 sz = uint64(isLong ? int64(pos[i].szi) : -int64(pos[i].szi));
                _send(1, abi.encode(uint32(pos[i].coin), !isLong, isLong ? uint64(1) : type(uint64).max, sz, true, uint8(3), uint128(0)));
            }
        }
    }

    // Health
    function getHealthFactor() public view returns (uint256) {
        (, , , , , uint256 hf) = lendingPool.getUserAccountData(address(this));
        return hf / 1e14;
    }

    function checkHealth() external view returns (uint8) {
        uint256 hf = getHealthFactor();
        if (hf < EMERGENCY_THRESHOLD) return 3;
        if (hf < DELEVER_THRESHOLD) return 2;
        if (hf < TRIM_THRESHOLD) return 1;
        return 0;
    }

    function trimFromPerp(uint64 amount) external onlyKeeper {
        _send(7, abi.encode(amount, false));
        emit EarningsTrimmed("perp", amount);
    }

    function deleverage(uint256 repayAmount) external onlyKeeper {
        usdc.approve(address(lendingPool), repayAmount);
        lendingPool.repay(address(usdc), repayAmount, 2, address(this));
        emit Deleveraged(repayAmount, getHealthFactor());
    }

    function leverageUp(uint256 borrowAmount) external onlyKeeper {
        lendingPool.borrow(address(usdc), borrowAmount, 2, 0, address(this));
        emit LeveragedUp(borrowAmount, _getLeverage());
    }

    function emergencyExit() external onlyKeeper {
        // Close perps
        IL1.Pos[] memory pos = IL1(L1_READ).readPerpPositions(address(this));
        for (uint i = 0; i < pos.length; i++) {
            if (pos[i].szi != 0) {
                bool isLong = pos[i].szi > 0;
                uint64 sz = uint64(isLong ? int64(pos[i].szi) : -int64(pos[i].szi));
                _send(1, abi.encode(uint32(pos[i].coin), !isLong, isLong ? uint64(1) : type(uint64).max, sz, true, uint8(3), uint128(0)));
            }
        }

        // Repay debt
        (, uint256 debt, , , , ) = lendingPool.getUserAccountData(address(this));
        uint256 bal = usdc.balanceOf(address(this));
        if (debt > 0 && bal > 0) {
            uint256 toRepay = bal < debt ? bal : debt;
            usdc.approve(address(lendingPool), toRepay);
            lendingPool.repay(address(usdc), toRepay, 2, address(this));
        }

        // Withdraw collateral
        lendingPool.withdraw(address(usdc), type(uint256).max, address(this));
        emit EmergencyExit(usdc.balanceOf(address(this)));
    }

    // Views
    function getLendData() external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return lendingPool.getUserAccountData(address(this));
    }

    function getPerps() external view returns (IL1.Pos[] memory) {
        return IL1(L1_READ).readPerpPositions(address(this));
    }

    function getPerpEquity() external view returns (uint256) {
        return IL1(L1_READ).readVaultEquity(address(this));
    }

    function getCurrentLeverage() external view returns (uint256) {
        return _getLeverage();
    }

    // Internal
    function _send(uint8 id, bytes memory payload) internal {
        bytes memory d = new bytes(4 + payload.length);
        d[0] = 0x01; d[3] = bytes1(id);
        for (uint i = 0; i < payload.length; i++) d[4+i] = payload[i];
        ICoreWriter(CORE_WRITER).sendRawAction(d);
    }

    function _getLeverage() internal view returns (uint256) {
        (uint256 col, uint256 debt, , , , ) = lendingPool.getUserAccountData(address(this));
        if (col == 0) return 10000;
        uint256 equity = col > debt ? col - debt : 0;
        return equity == 0 ? maxLeverage : (col * 10000) / equity;
    }

    function rescueTokens(address t, uint256 amt) external onlyOwner { IERC20(t).safeTransfer(owner(), amt); }
    receive() external payable {}
}

interface IPool {
    function deposit(address, uint256, address, uint16) external;
    function withdraw(address, uint256, address) external returns (uint256);
    function borrow(address, uint256, uint256, uint16, address) external;
    function repay(address, uint256, uint256, address) external returns (uint256);
    function getUserAccountData(address) external view returns (uint256,uint256,uint256,uint256,uint256,uint256);
}

interface ICoreWriter { function sendRawAction(bytes calldata) external; }

interface IL1 {
    struct Pos { uint32 coin; int64 szi; int64 entryPx; }
    function readPerpPositions(address) external view returns (Pos[] memory);
    function readVaultEquity(address) external view returns (uint256);
}

interface IRouter {
    struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(Params calldata) external payable returns (uint256);
}

interface IWHYPE { function withdraw(uint256) external; }

