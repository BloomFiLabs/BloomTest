// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/HyperEVMFundingStrategy.sol";
import "../src/HyperEVMInterfaces.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {
        _mint(msg.sender, 1_000_000_000 * 1e6);
    }
    
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
    
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract MockL1Read is IL1Read {
    PerpsPosition[] public positions;
    SpotBalance[] public balances;
    uint256 public equity;
    uint64 public l1BlockNumber;
    
    function readPerpPositions(address /*user*/) external view override returns (PerpsPosition[] memory) {
        return positions;
    }
    
    function readSpotBalances(address /*user*/) external view override returns (SpotBalance[] memory) {
        return balances;
    }
    
    function readVaultEquity(address /*user*/) external view override returns (uint256) {
        return equity;
    }
    
    function readOraclePrices(uint256[] calldata /*assets*/) external view override returns (uint256[] memory) {
        // Return dummy prices
        return new uint256[](0); 
    }
    
    function readL1BlockNumber() external view override returns (uint64) {
        return l1BlockNumber;
    }

    // Helpers to set state
    function setPerpPosition(uint256 coin, int256 szi) external {
        // Simple mock: just overwrite or push
        // For simplicity, let's just keep one position in the array or clear it
        delete positions;
        if (szi != 0) {
            positions.push(PerpsPosition({
                coin: coin,
                szi: szi,
                entryPx: 1000e8,
                positionValue: 1000e6,
                unrealizedPnl: 0,
                liquidationPx: 0,
                marginUsed: 100e6,
                maxLeverage: 50,
                cumFunding: 0
            }));
        }
    }
    
    function setVaultEquity(uint256 _equity) external {
        equity = _equity;
    }
}

contract MockCoreWriter is ICoreWriter {
    event ActionSent(uint8 version, uint24 actionId, bytes payload);

    function sendRawAction(bytes calldata action) external override {
        // Decode manually
        // Byte 0: Version
        // Byte 1-3: Action ID
        // Rest: Payload
        
        uint8 version = uint8(action[0]);
        uint24 actionId = uint24(uint8(action[1])) << 16 | uint24(uint8(action[2])) << 8 | uint24(uint8(action[3]));
        
        bytes memory payload = new bytes(action.length - 4);
        for(uint i=0; i<payload.length; i++) {
            payload[i] = action[i+4];
        }
        
        emit ActionSent(version, actionId, payload);
    }
}

contract HyperEVMFundingStrategyTest is Test {
    HyperEVMFundingStrategy strategy;
    MockERC20 usdc;
    MockL1Read l1ReadMock;
    MockCoreWriter coreWriterMock;
    
    address vault = address(0x10);
    address keeper = address(0x20);
    address user = address(0x30);
    uint32 constant ASSET_ID = 1; // ETH
    
    // Hardcoded addresses from the strategy
    address constant L1_READ_ADDR = 0x0000000000000000000000000000000000000800;
    address constant CORE_WRITER_ADDR = 0x3333333333333333333333333333333333333333;

    event ActionSent(uint8 version, uint24 actionId, bytes payload);
    event Rebalanced(int256 targetDelta, uint256 timestamp);
    event EmergencyExit(uint256 assetsRecovered);

    function setUp() public {
        usdc = new MockERC20();
        
        // Deploy Mocks to specific addresses
        MockL1Read l1ReadImpl = new MockL1Read();
        bytes memory l1ReadCode = address(l1ReadImpl).code;
        vm.etch(L1_READ_ADDR, l1ReadCode);
        l1ReadMock = MockL1Read(L1_READ_ADDR); // Cast to interface/mock at that address

        MockCoreWriter coreWriterImpl = new MockCoreWriter();
        bytes memory coreWriterCode = address(coreWriterImpl).code;
        vm.etch(CORE_WRITER_ADDR, coreWriterCode);
        coreWriterMock = MockCoreWriter(CORE_WRITER_ADDR);

        // Deploy Strategy
        vm.startPrank(vault); 
        strategy = new HyperEVMFundingStrategy(vault, address(usdc), ASSET_ID);
        
        // Setup Keeper
        strategy.setKeeper(keeper, true);
        vm.stopPrank();
        
        // Give USDC to User and Vault
        usdc.mint(user, 100_000e6);
        usdc.mint(vault, 100_000e6);
        
        // Approve strategy
        vm.startPrank(vault);
        usdc.approve(address(strategy), type(uint256).max);
        vm.stopPrank();
    }

    function test_Deposit() public {
        uint256 amount = 1000e6;
        
        // Expect Action 7 (USD Transfer)
        // Payload: (uint64 ntl, bool toPerp) -> (amount, true)
        bytes memory expectedPayload = abi.encode(uint64(amount), true);
        
        vm.expectEmit(true, true, true, true, CORE_WRITER_ADDR);
        emit ActionSent(1, 7, expectedPayload);
        
        vm.prank(vault);
        strategy.deposit(amount);
        
        assertEq(strategy.totalPrincipal(), amount);
        assertEq(usdc.balanceOf(address(strategy)), amount);
    }

    function test_Withdraw() public {
        // Setup: Deposit first
        uint256 amount = 1000e6;
        vm.prank(vault);
        strategy.deposit(amount);
        
        uint256 withdrawAmount = 500e6;
        
        // Expect Action 7: (amount, false)
        bytes memory expectedPayload = abi.encode(uint64(withdrawAmount), false);
        
        vm.expectEmit(true, true, true, true, CORE_WRITER_ADDR);
        emit ActionSent(1, 7, expectedPayload);
        
        vm.prank(vault);
        strategy.withdraw(withdrawAmount);
        
        assertEq(strategy.totalPrincipal(), amount - withdrawAmount);
        assertEq(usdc.balanceOf(vault), 100_000e6 - amount + withdrawAmount);
    }

    function test_Rebalance_Long() public {
        bool isLong = true;
        uint64 price = 2000e8;
        uint64 size = 10e8; // 10 units
        bool reduceOnly = false;
        
        // Action 1: Limit Order
        // (asset, isBuy, limitPx, sz, reduceOnly, encodedTif, cloid)
        // TIF = 3 (IOC), cloid = 0
        bytes memory expectedPayload = abi.encode(
            ASSET_ID,
            isLong,
            price,
            size,
            reduceOnly,
            uint8(3),
            uint128(0)
        );
        
        vm.expectEmit(true, true, true, true, CORE_WRITER_ADDR);
        emit ActionSent(1, 1, expectedPayload);
        
        vm.expectEmit(false, false, false, true, address(strategy));
        emit Rebalanced(int256(uint256(size)), block.timestamp);

        vm.prank(keeper);
        strategy.rebalance(isLong, price, size, reduceOnly);
    }
    
    function test_Rebalance_Short() public {
        bool isLong = false;
        uint64 price = 2000e8;
        uint64 size = 5e8; 
        bool reduceOnly = false;
        
        bytes memory expectedPayload = abi.encode(
            ASSET_ID,
            isLong,
            price,
            size,
            reduceOnly,
            uint8(3),
            uint128(0)
        );
        
        vm.expectEmit(true, true, true, true, CORE_WRITER_ADDR);
        emit ActionSent(1, 1, expectedPayload);
        
        vm.expectEmit(false, false, false, true, address(strategy));
        emit Rebalanced(-int256(uint256(size)), block.timestamp);

        vm.prank(keeper);
        strategy.rebalance(isLong, price, size, reduceOnly);
    }

    function test_EmergencyExit() public {
        // 1. Setup open position in MockL1Read
        // Long 10 units
        l1ReadMock.setPerpPosition(uint256(ASSET_ID), 10e8);
        
        // 2. Setup Equity
        l1ReadMock.setVaultEquity(5000e6); // 5000 USDC equity
        
        // Expect Action 1 to close (Sell 10 units)
        // isLong=false, price=0 (Market/Sell), size=10e8, reduceOnly=true
        bytes memory closePayload = abi.encode(
            ASSET_ID,
            false, // Sell
            uint64(0), // LimitPx 0 for sell
            uint64(10e8),
            true, // reduceOnly
            uint8(3), // IOC
            uint128(0)
        );
        
        // Expect Action 7 to withdraw equity
        // (5000e6, false)
        bytes memory withdrawPayload = abi.encode(uint64(5000e6), false);
        
        vm.expectEmit(true, true, true, true, CORE_WRITER_ADDR);
        emit ActionSent(1, 1, closePayload);
        
        vm.expectEmit(true, true, true, true, CORE_WRITER_ADDR);
        emit ActionSent(1, 7, withdrawPayload);
        
        vm.prank(keeper);
        strategy.emergencyExit();
    }

    function test_ClaimRewards() public {
        // Principal 1000
        vm.prank(vault);
        strategy.deposit(1000e6);
        
        // Equity 1200 (200 profit)
        l1ReadMock.setVaultEquity(1200e6);
        
        // Expect Action 7 (200, false)
        bytes memory expectedPayload = abi.encode(uint64(200e6), false);
        
        vm.expectEmit(true, true, true, true, CORE_WRITER_ADDR);
        emit ActionSent(1, 7, expectedPayload);
        
        // Expect transfer to recipient
        address recipient = address(0x99);
        
        strategy.claimRewards(recipient);
        
        assertEq(usdc.balanceOf(recipient), 200e6);
    }
}



