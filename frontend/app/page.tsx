"use client";

import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  AlertCircle, 
  CheckCircle2, 
  RefreshCw, 
  LayoutDashboard, 
  ShieldAlert,
  History,
  Coins
} from 'lucide-react';
import { cn } from "@/lib/utils";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const DIAGNOSTICS_URL = 'https://keeper-q2n9z.ondigitalocean.app/keeper/diagnostics';
const RESET_URL = 'https://keeper-q2n9z.ondigitalocean.app/keeper/reset-metrics';

export default function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const response = await fetch(DIAGNOSTICS_URL);
      const json = await response.json();
      setData(json);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Are you sure you want to reset all performance metrics? This will restart APY calculation from zero.')) return;
    
    try {
      setIsResetting(true);
      const response = await fetch(RESET_URL, { method: 'POST' });
      const result = await response.json();
      alert(result.message);
      await fetchData();
    } catch (err: any) {
      alert('Error resetting metrics: ' + err.message);
    } finally {
      setIsResetting(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // 30s refresh
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-slate-400">
        <RefreshCw className="w-10 h-10 animate-spin mb-4 text-indigo-500" />
        <p className="text-lg font-medium animate-pulse">Loading Quant Dashboard...</p>
      </div>
    );
  }

  const apy = data?.apy || { estimated: 0, realized: 0, byExchange: {}, expectedEarningsNextPeriod: 0, historicalEarnings: [] };
  const positions = data?.positions || { count: 0, totalValue: 0, unrealizedPnl: 0, byExchange: {} };
  const health = data?.health || { overall: 'UNKNOWN', issues: [] };
  const rewards = data?.rewards || { accruedProfits: 0, totalHarvested: 0 };

  return (
    <main className="min-h-screen bg-[#020617] text-slate-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <LayoutDashboard className="w-6 h-6 text-indigo-500" />
              <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                Bloom Keeper
              </h1>
            </div>
            <p className="text-slate-400 text-sm">Delta-Neutral Funding Arbitrage Engine</p>
          </div>
          
          <div className="flex flex-wrap gap-3">
            <button 
              onClick={handleReset}
              disabled={isResetting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-sm font-semibold transition-all disabled:opacity-50"
            >
              <History className="w-4 h-4" />
              Reset APY
            </button>
            <button 
              onClick={fetchData}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold shadow-lg shadow-indigo-500/20 transition-all"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
              Refresh
            </button>
          </div>
        </header>

        {/* Top Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard 
            title="Realized APY" 
            value={`${apy.realized.toFixed(2)}%`}
            subValue="Based on historical funding"
            trend={apy.realized >= 0 ? 'up' : 'down'}
          />
          <MetricCard 
            title="Estimated APY" 
            value={`${apy.estimated.toFixed(2)}%`}
            subValue="Projected forward"
            trend={apy.estimated >= 0 ? 'up' : 'down'}
          />
          <MetricCard 
            title="Next 1h Return" 
            value={`$${(apy.expectedEarningsNextPeriod || 0).toFixed(4)}`}
            subValue="Predicted from active positions"
            trend={apy.expectedEarningsNextPeriod >= 0 ? 'up' : 'down'}
            icon={<Coins className="w-4 h-4 text-indigo-400" />}
          />
          <MetricCard 
            title="Net Funding" 
            value={`$${(apy.netFunding || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            subValue="Total funding captured (USD)"
            trend={apy.netFunding >= 0 ? 'up' : 'down'}
            icon={<Coins className="w-4 h-4 text-emerald-400" />}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard 
            title="Realized PnL" 
            value={`$${(apy.realizedPnl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            subValue="Total profit/loss from trades"
            trend={apy.realizedPnl >= 0 ? 'up' : 'down'}
          />
          <MetricCard 
            title="Current NAV" 
            value={`$${positions.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            subValue={`Unrealized: ${positions.unrealizedPnl >= 0 ? '+' : ''}$${positions.unrealizedPnl.toFixed(4)}`}
            trend={positions.unrealizedPnl >= 0 ? 'up' : 'down'}
          />
          <MetricCard 
            title="Accrued Profits" 
            value={`$${rewards.accruedProfits.toFixed(2)}`}
            subValue={`Total Harvested: $${rewards.totalHarvested.toFixed(2)}`}
            icon={<Coins className="w-4 h-4 text-amber-400" />}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          <div className="lg:col-span-2 space-y-6">
            {/* Historical Earnings Graph */}
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-6 shadow-sm">
              <h2 className="text-lg font-semibold mb-6 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-indigo-500" />
                Funding Earnings (Expected vs Actual)
              </h2>
              <div className="h-[300px] w-full">
                <EarningsChart data={apy.historicalEarnings} />
              </div>
            </div>

            {/* Active Positions */}
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
                <h2 className="font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  Active Exchange Exposure
                </h2>
                <span className="text-xs text-slate-500">{positions.count} Total Legs</span>
              </div>
              <div className="p-0 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-950/50 text-slate-400 font-medium">
                    <tr>
                      <th className="px-4 py-3">Exchange</th>
                      <th className="px-4 py-3">Symbol</th>
                      <th className="px-4 py-3">Size</th>
                      <th className="px-4 py-3 text-right">Value (USD)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {data?.positions?.activePositions && data.positions.activePositions.length > 0 ? (
                      data.positions.activePositions.map((pos: any, i: number) => (
                        <tr key={`${pos.exchange}-${pos.symbol}-${i}`} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-4">
                            <span className="px-2 py-1 rounded-md bg-indigo-500/10 text-indigo-400 font-bold text-[10px] uppercase border border-indigo-500/20">
                              {pos.exchange}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-slate-300 font-medium">{pos.symbol}</td>
                          <td className={cn(
                            "px-4 py-4 font-mono text-xs",
                            pos.side === 'LONG' ? "text-green-400" : "text-red-400"
                          )}>
                            {pos.side} {Math.abs(pos.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                          </td>
                          <td className="px-4 py-4 text-right font-mono font-bold">
                            ${pos.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                      ))
                    ) : Object.keys(positions.byExchange).length > 0 ? (
                      Object.keys(positions.byExchange).map((exchange) => (
                        <tr key={exchange} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-4">
                            <span className="px-2 py-1 rounded-md bg-indigo-500/10 text-indigo-400 font-bold text-xs uppercase border border-indigo-500/20">
                              {exchange}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-slate-300 font-medium">Aggregate</td>
                          <td className="px-4 py-4 text-slate-400">---</td>
                          <td className="px-4 py-4 text-right font-mono font-bold">
                            ${positions.byExchange[exchange].toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-slate-500 italic">
                          No active positions detected.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* APY Breakdown by Exchange */}
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Funding Capture by Exchange</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {Object.keys(apy.byExchange).map((ex) => (
                  <div key={ex} className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                    <p className="text-xs text-slate-500 mb-1 font-bold uppercase">{ex}</p>
                    <p className={cn(
                      "text-xl font-bold font-mono",
                      apy.byExchange[ex] >= 0 ? "text-green-400" : "text-red-400"
                    )}>
                      {apy.byExchange[ex].toFixed(2)}% <span className="text-[10px] text-slate-600">APY</span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Sidebar: Health & Errors */}
          <div className="space-y-6">
            {/* Health Card */}
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-semibold text-slate-300">System Integrity</h3>
                <div className={cn(
                  "px-3 py-1 rounded-full text-xs font-bold uppercase border flex items-center gap-1.5",
                  health.overall === 'OK' ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"
                )}>
                  <div className={cn("w-2 h-2 rounded-full", health.overall === 'OK' ? "bg-green-500" : "bg-red-500")} />
                  {health.overall}
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="flex justify-between items-center py-2 border-b border-slate-800/50">
                  <span className="text-sm text-slate-400">Connection HL</span>
                  <span className="text-sm font-semibold text-green-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Live
                  </span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-800/50">
                  <span className="text-sm text-slate-400">Connection Lighter</span>
                  <span className="text-sm font-semibold text-green-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Live
                  </span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-800/50">
                  <span className="text-sm text-slate-400">Global Lock</span>
                  <span className="text-sm text-slate-500 font-mono">IDLE</span>
                </div>
              </div>
            </div>

            {/* Recent Errors */}
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5 shadow-sm overflow-hidden flex flex-col max-h-[400px]">
              <h3 className="font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-red-400" />
                Live Error Log
              </h3>
              <div className="space-y-3 overflow-y-auto pr-2 custom-scrollbar">
                {data?.errors?.recent && data.errors.recent.length > 0 ? (
                  data.errors.recent.slice(0, 10).map((err: any, i: number) => (
                    <div key={i} className="p-3 rounded-lg bg-red-500/5 border border-red-500/10 text-xs">
                      <div className="flex justify-between mb-1">
                        <span className="font-bold text-red-400">{err.type}</span>
                        <span className="text-slate-500 font-mono">{err.time}</span>
                      </div>
                      <p className="text-slate-400 leading-relaxed line-clamp-2">{err.msg}</p>
                    </div>
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 opacity-30">
                    <AlertCircle className="w-8 h-8 mb-2" />
                    <p className="text-sm italic">No recent anomalies detected.</p>
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <footer className="text-center text-slate-600 text-xs pt-8 border-t border-slate-900">
          <p>© 2025 Bloom Finance • Running at {DIAGNOSTICS_URL.split('/')[2]} • Latency: {data?.uptime?.hours.toFixed(1)}h runtime</p>
        </footer>
      </div>
    </main>
  );
}

function MetricCard({ title, value, subValue, trend, icon }: { title: string, value: string, subValue: string, trend?: 'up' | 'down', icon?: React.ReactNode }) {
// ... same component ...
}

function EarningsChart({ data }: { data: any[] }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-600 italic">
        <TrendingUp className="w-12 h-12 mb-2 opacity-10" />
        <p>Awaiting sufficient historical data...</p>
      </div>
    );
  }

  const chartData = {
    labels: data.map(d => {
      const date = new Date(d.timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }),
    datasets: [
      {
        label: 'Actual Earnings',
        data: data.map(d => d.actual),
        borderColor: '#10b981', // emerald-500
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        borderWidth: 2,
        tension: 0.4,
        fill: true,
        pointRadius: 3,
        pointHoverRadius: 5,
      },
      {
        label: 'Expected Earnings',
        data: data.map(d => d.expected),
        borderColor: '#6366f1', // indigo-500
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [5, 5],
        tension: 0.4,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 5,
      }
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
        align: 'end' as const,
        labels: {
          color: '#94a3b8', // slate-400
          boxWidth: 12,
          font: {
            size: 11,
            weight: 'bold' as any,
          },
          padding: 20,
        },
      },
      tooltip: {
        backgroundColor: '#0f172a', // slate-900
        titleColor: '#f8fafc',
        bodyColor: '#cbd5e1',
        borderColor: '#1e293b',
        borderWidth: 1,
        padding: 12,
        callbacks: {
          label: function(context: any) {
            let label = context.dataset.label || '';
            if (label) {
              label += ': ';
            }
            if (context.parsed.y !== null) {
              label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4 }).format(context.parsed.y);
            }
            return label;
          }
        }
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: {
          color: '#64748b', // slate-500
          font: {
            size: 10,
          },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
        },
      },
      y: {
        grid: {
          color: '#1e293b', // slate-800
        },
        ticks: {
          color: '#64748b',
          font: {
            size: 10,
          },
          callback: function(value: any) {
            return '$' + value.toFixed(2);
          }
        },
      },
    },
  };

  return <Line data={chartData} options={options} />;
}

