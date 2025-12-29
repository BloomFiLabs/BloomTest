import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp, Newline } from 'ink';
import axios from 'axios';

// Clear console before starting
console.clear();
process.stdout.write('\x1B[2J\x1B[0f');

const BASE_URL = 'http://localhost:3000/tui';

const App = () => {
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await axios.get(`${BASE_URL}/status`);
        setStatus(response.data);
        setError(null);
        setLoading(false);
        setTick(t => t + 1);
      } catch (err: any) {
        setError(`Failed to connect: ${err.message}`);
        setLoading(false);
      }
    };

    const interval = setInterval(fetchData, 1000);
    fetchData();

    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <Text color="cyan">Loading Bloom Keeper TUI...</Text>;
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red" bold>❌ {error}</Text>
        <Text color="gray">Make sure bloom-keeper is running on port 3000</Text>
      </Box>
    );
  }

  const { portfolio, diagnostics, recentDecisions, logs, groupedErrors, errorCount } = status;
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][tick % 10];

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text color="cyan" bold>╔══════════════════════════════════════════════════════════════════════════════╗</Text>
      </Box>
      <Box>
        <Text color="cyan" bold>║</Text>
        <Text color="green" bold>  🌸 BLOOM KEEPER </Text>
        <Text color="white">- Master Quant Console</Text>
        <Text color="gray">                              {spinner} </Text>
        <Text color="cyan" bold>║</Text>
      </Box>
      <Box>
        <Text color="cyan" bold>╚══════════════════════════════════════════════════════════════════════════════╝</Text>
      </Box>

      {/* Portfolio Stats */}
      <Box marginTop={1}>
        <Text color="white" bold>💰 PORTFOLIO </Text>
        <Text color="gray">│ </Text>
        <Text color="green" bold>${portfolio.totalEquity.toFixed(2)}</Text>
        <Text color="gray"> total │ HL: </Text>
        <Text color="cyan">${portfolio.hlEquity.toFixed(2)}</Text>
        <Text color="gray"> │ Lighter: </Text>
        <Text color="blue">${portfolio.lighterEquity.toFixed(2)}</Text>
        <Text color="gray"> │ Lock: </Text>
        <Text color={diagnostics.globalLock.held ? 'red' : 'green'}>
          {diagnostics.globalLock.held ? `🔒 ${diagnostics.globalLock.holder}` : '🟢 IDLE'}
        </Text>
      </Box>

      {/* Positions */}
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow" bold>📊 POSITIONS ({portfolio.hlPositions.length + portfolio.lighterPositions.length})</Text>
        {portfolio.hlPositions.length === 0 && portfolio.lighterPositions.length === 0 ? (
          <Text color="gray">  No open positions</Text>
        ) : (
          <>
            {portfolio.hlPositions.map((p: any, i: number) => (
              <Text key={`hl-${i}`} color="gray">
                <Text color="cyan">  [HL] </Text>
                <Text color={p.side === 'LONG' ? 'green' : 'red'}>{p.side.padEnd(5)}</Text>
                <Text color="white"> {p.symbol.padEnd(10)}</Text>
                <Text color="gray"> size: </Text>
                <Text color="white">{Math.abs(p.size).toFixed(2).padStart(10)}</Text>
                <Text color="gray"> pnl: </Text>
                <Text color={p.unrealizedPnl >= 0 ? 'green' : 'red'}>${p.unrealizedPnl?.toFixed(2) || '0.00'}</Text>
              </Text>
            ))}
            {portfolio.lighterPositions.map((p: any, i: number) => (
              <Text key={`lt-${i}`} color="gray">
                <Text color="blue">  [LT] </Text>
                <Text color={p.side === 'LONG' ? 'green' : 'red'}>{p.side.padEnd(5)}</Text>
                <Text color="white"> {p.symbol.padEnd(10)}</Text>
                <Text color="gray"> size: </Text>
                <Text color="white">{Math.abs(p.size).toFixed(2).padStart(10)}</Text>
                <Text color="gray"> pnl: </Text>
                <Text color={p.unrealizedPnl >= 0 ? 'green' : 'red'}>${p.unrealizedPnl?.toFixed(2) || '0.00'}</Text>
              </Text>
            ))}
          </>
        )}
      </Box>

      {/* Active Execution Progress */}
      {diagnostics.currentExecution && (
        <Box marginTop={1} flexDirection="column">
          <Text color="green" bold>🔄 ACTIVE EXECUTION</Text>
          <Box>
            <Text color="white">  </Text>
            <Text color="yellow" bold>{diagnostics.currentExecution.symbol}</Text>
            <Text color="gray"> │ </Text>
            <Text color="cyan" bold>
              Slice {diagnostics.currentExecution.currentSlice}/{diagnostics.currentExecution.totalSlices}
            </Text>
            <Text color="gray"> │ </Text>
            <Text color="magenta">{diagnostics.currentExecution.operation}</Text>
          </Box>
          <Box>
            <Text color="gray">  Leg A ({diagnostics.currentExecution.legAExchange}): </Text>
            <Text color={
              diagnostics.currentExecution.legAStatus === 'FILLED' ? 'green' :
              diagnostics.currentExecution.legAStatus === 'WAITING_FILL' ? 'yellow' :
              diagnostics.currentExecution.legAStatus === 'FAILED' ? 'red' : 'gray'
            }>
              {diagnostics.currentExecution.legAStatus}
            </Text>
            <Text color="gray"> │ Leg B ({diagnostics.currentExecution.legBExchange}): </Text>
            <Text color={
              diagnostics.currentExecution.legBStatus === 'FILLED' ? 'green' :
              diagnostics.currentExecution.legBStatus === 'WAITING_FILL' ? 'yellow' :
              diagnostics.currentExecution.legBStatus === 'FAILED' ? 'red' : 'gray'
            }>
              {diagnostics.currentExecution.legBStatus}
            </Text>
          </Box>
          <Box>
            <Text color="gray">  Running for: {Math.round((Date.now() - new Date(diagnostics.currentExecution.startedAt).getTime()) / 1000)}s</Text>
          </Box>
        </Box>
      )}

      {/* Active Orders */}
      <Box marginTop={1} flexDirection="column">
        <Text color="magenta" bold>⚡ ACTIVE ORDERS ({diagnostics.activeOrders.length})</Text>
        {diagnostics.activeOrders.length === 0 ? (
          <Text color="gray">  No active orders</Text>
        ) : (
          diagnostics.activeOrders.map((o: any, i: number) => (
            <Text key={i}>
              <Text color="gray">  </Text>
              <Text color={o.side === 'LONG' ? 'green' : 'red'}>{o.side.padEnd(5)}</Text>
              <Text color="white"> {o.symbol.padEnd(10)}</Text>
              <Text color="gray"> @ </Text>
              <Text color="yellow">{o.price?.toFixed(4) || 'MKT'}</Text>
              <Text color="gray"> │ {o.exchange.padEnd(12)} │ </Text>
              <Text color="cyan">{o.status}</Text>
              <Text color="gray"> │ {Math.round((Date.now() - new Date(o.placedAt).getTime()) / 1000)}s</Text>
            </Text>
          ))
        )}
      </Box>

      {/* Symbol Locks */}
      {diagnostics.symbolLocks.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>🔒 LOCKED SYMBOLS</Text>
          {diagnostics.symbolLocks.map((l: any) => (
            <Text key={l.symbol} color="gray">
              <Text color="red">  {l.symbol}</Text>
              <Text color="gray"> - {l.operation} ({Math.round(l.durationMs / 1000)}s)</Text>
            </Text>
          ))}
        </Box>
      )}

      {/* Recent Decisions */}
      <Box marginTop={1} flexDirection="column">
        <Text color="blue" bold>🧠 TRADE DECISIONS (last 5)</Text>
        {recentDecisions.length === 0 ? (
          <Text color="gray">  No recent decisions</Text>
        ) : (
          recentDecisions.slice(0, 5).map((d: any, i: number) => (
            <Text key={i}>
              <Text color="gray">  [{new Date(d.timestamp).toLocaleTimeString()}] </Text>
              <Text color={d.decision === 'EXECUTED' ? 'green' : d.decision === 'REJECTED' ? 'yellow' : 'red'}>
                {d.decision.padEnd(8)}
              </Text>
              <Text color="white"> {d.symbol.padEnd(8)}</Text>
              <Text color="gray"> {d.reason.substring(0, 50)}{d.reason.length > 50 ? '...' : ''}</Text>
            </Text>
          ))
        )}
      </Box>

      {/* System Logs */}
      <Box marginTop={1} flexDirection="column">
        <Text color="gray" bold>📝 SYSTEM LOGS (last 5)</Text>
        {logs.slice(0, 5).map((l: any, i: number) => {
          let color: any = 'white';
          if (l.level === 'ERROR') color = 'red';
          if (l.level === 'WARN') color = 'yellow';
          if (l.level === 'DEBUG') color = 'gray';
          
          return (
            <Text key={i}>
              <Text color="gray">  [{new Date(l.timestamp).toLocaleTimeString()}] </Text>
              <Text color={color}>[{l.context.substring(0, 20).padEnd(20)}] </Text>
              <Text color="gray">{l.message.substring(0, 50)}{l.message.length > 50 ? '...' : ''}</Text>
            </Text>
          );
        })}
      </Box>

      {/* Grouped Errors */}
      {groupedErrors && groupedErrors.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>🚨 ERRORS ({errorCount} total)</Text>
          {groupedErrors.slice(0, 6).map((err: any, i: number) => (
            <Text key={i}>
              <Text color="gray">  </Text>
              <Text color="red">[{err.context.substring(0, 15)}] </Text>
              <Text color="white">{err.message.substring(0, 50)}{err.message.length > 50 ? '...' : ''}</Text>
              {err.count > 1 && (
                <Text color="yellow" bold> x{err.count}</Text>
              )}
            </Text>
          ))}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text color="gray">─────────────────────────────────────────────────────────────────────────────────</Text>
      </Box>
      <Box>
        <Text color="gray">Ctrl+C to exit │ Refreshing every 1s │ </Text>
        <Text color="cyan">Bloom Master Quant Console v2.0</Text>
      </Box>
    </Box>
  );
};

render(<App />);
