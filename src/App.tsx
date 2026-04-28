import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import {
  Flame,
  RefreshCw,
  Scan,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Wallet,
  ChevronRight,
  Zap,
  Shield,
  X,
} from "lucide-react";
import { AppKit } from "@circle-fin/app-kit";
import { createAdapter } from "@circle-fin/adapter-viem-v2";
import { createWalletClient, custom, encodeAbiParameters } from "viem";

// ─── Constants ───────────────────────────────────────────────────────────────
const TREASURY = "0x64D868100191D920D8d52F05F91462Bc702ba0ba";
const PROTOCOL_FEE_BPS = 1000; // 10%
const KIT_KEY = import.meta.env.VITE_CIRCLE_KIT_KEY as string;
const RESERVOIR_BASE = "https://api.reservoir.tools";

// Arc Testnet chain identifier per the official SDK enum
const ARC_CHAIN = "Arc_Testnet";

// ─── Types ────────────────────────────────────────────────────────────────────
interface NFT {
  tokenId: string;
  name: string;
  image: string | null;
  collection: string;
  contract: string;
  floorPrice: number | null; // ETH
  topBid: number | null;     // USDC equivalent (from Reservoir)
  topBidUSDC: string | null; // human-readable
  hasBid: boolean;
}

type ActionStatus = "idle" | "pending" | "success" | "error";

interface NFTAction {
  tokenId: string;
  contract: string;
  type: "recycle" | "burn";
  status: ActionStatus;
  txHash?: string;
  error?: string;
  usdcOut?: string;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [nfts, setNfts] = useState<NFT[]>([]);
  const [scanning, setScanning] = useState(false);
  const [actions, setActions] = useState<Record<string, NFTAction>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [walletClient, setWalletClient] = useState<ReturnType<typeof createWalletClient> | null>(null);

  // ─── Wallet Connection ────────────────────────────────────────────────────
  const connectWallet = async () => {
    try {
      if (!window.ethereum) throw new Error("No EVM wallet found. Install MetaMask or similar.");
      const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setWalletAddress(address);

      const client = createWalletClient({
        account: address as `0x${string}`,
        transport: custom(window.ethereum),
      });
      setWalletClient(client);
      setGlobalError(null);
    } catch (e: any) {
      setGlobalError(e.message ?? "Wallet connection failed.");
    }
  };

  // ─── Reservoir Dust Scan ──────────────────────────────────────────────────
  const scanWallet = useCallback(async () => {
    if (!walletAddress) return;
    setScanning(true);
    setNfts([]);
    setSelectedIds(new Set());
    setGlobalError(null);

    try {
      // Fetch tokens owned by wallet from Reservoir
      const { data } = await axios.get(`${RESERVOIR_BASE}/users/${walletAddress}/tokens/v7`, {
        params: {
          limit: 50,
          includeTopBid: true,
          includeAttributes: false,
        },
      });

      const tokens: NFT[] = (data.tokens ?? []).map((t: any) => {
        const token = t.token;
        const market = t.market;

        const topBidRaw: number | null =
          market?.topBid?.price?.amount?.decimal ?? null;
        const topBidUSDC: string | null =
          topBidRaw !== null ? topBidRaw.toFixed(4) : null;
        const floorPrice: number | null =
          market?.floorAsk?.price?.amount?.decimal ?? null;
        const hasBid = topBidRaw !== null && topBidRaw > 0;

        return {
          tokenId: token.tokenId,
          name: token.name ?? `#${token.tokenId}`,
          image: token.image ?? null,
          collection: token.collection?.name ?? token.contract,
          contract: token.contract,
          floorPrice,
          topBid: topBidRaw,
          topBidUSDC,
          hasBid,
        } satisfies NFT;
      });

      setNfts(tokens);
    } catch (e: any) {
      setGlobalError("Reservoir scan failed: " + (e.message ?? "unknown error"));
    } finally {
      setScanning(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (walletAddress) scanWallet();
  }, [walletAddress, scanWallet]);

  // ─── Revenue-split calculation ────────────────────────────────────────────
  const calcSplit = (topBidUSDC: string) => {
    const total = parseFloat(topBidUSDC);
    const fee = +(total * (PROTOCOL_FEE_BPS / 10000)).toFixed(4);
    const userGet = +(total - fee).toFixed(4);
    return { fee, userGet };
  };

  // ─── Arc Swap Kit – Recycle (bid fulfillment + fee split) ─────────────────
  const handleRecycle = async (nft: NFT) => {
    if (!walletClient || !nft.topBid || !nft.topBidUSDC) return;
    const key = `${nft.contract}-${nft.tokenId}`;
    const { userGet, fee } = calcSplit(nft.topBidUSDC);

    setActions((prev) => ({
      ...prev,
      [key]: { tokenId: nft.tokenId, contract: nft.contract, type: "recycle", status: "pending" },
    }));

    try {
      const adapter = createAdapter({ walletClient });
      const kit = new AppKit();

      // The sell order proceeds to the user (90%), protocol fee (10%) to treasury
      // We use kit.swap to execute the sell order and apply the revenue share
      const result = await kit.swap({
        from: { adapter, chain: ARC_CHAIN },
        tokenIn: "USDC",   // sell NFT for USDC
        tokenOut: "USDC",  // output token (net to user)
        amountIn: nft.topBidUSDC,
        config: {
          kitKey: KIT_KEY,
          slippageBps: 50,
          customFee: {
            // 10% fee routed to treasury
            percentage: PROTOCOL_FEE_BPS / 100, // SDK expects percentage as number
            recipientAddress: TREASURY,
          },
        },
      });

      setActions((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: "success",
          txHash: result.txHash,
          usdcOut: String(userGet),
        },
      }));
    } catch (e: any) {
      setActions((prev) => ({
        ...prev,
        [key]: { ...prev[key], status: "error", error: e.message ?? "Swap failed" },
      }));
    }
  };  // ─── Burn (zero-bid NFTs) ─────────────────────────────────────────────────
  const handleBurn = async (nft: NFT) => {
    if (!walletClient || !walletAddress) return;
    const key = `${nft.contract}-${nft.tokenId}`;

    setActions((prev) => ({
      ...prev,
      [key]: { tokenId: nft.tokenId, contract: nft.contract, type: "burn", status: "pending" },
    }));

    try {
      const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

      // Encodes the safeTransferFrom data to move the NFT to the burn address
      const data = encodeERC721Transfer(walletAddress as `0x${string}`, BURN_ADDRESS, BigInt(nft.tokenId));

      const txHash = await walletClient.sendTransaction({
        to: nft.contract as 0x${string},
        data,
      });

      setActions((prev) => ({
        ...prev,
        [key]: { ...prev[key], status: "success", txHash },
      }));
    } catch (e: any) {
      setActions((prev) => ({
        ...prev,
        [key]: { ...prev[key], status: "error", error: e.message ?? "Burn failed" },
      }));
    }
  };
const nft of selected) {
      if (nft.hasBid) await handleRecycle(nft);
      else await handleBurn(nft);
    }
  };

  const toggleSelect = (key: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectAll = () =>
    setSelectedIds(new Set(nfts.map((n) => `${n.contract}-${n.tokenId}`)));
  const clearAll = () => setSelectedIds(new Set());

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* Scanlines overlay */}
      <div style={styles.scanlines} />

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logo}>
            <Zap size={22} color="#00ffcc" />
            <span style={styles.logoText}>NFT CLEANER</span>
            <span style={styles.logoBadge}>PROTOCOL</span>
          </div>

          {walletAddress ? (
            <div style={styles.walletPill}>
              <div style={styles.walletDot} />
              <span style={styles.walletAddr}>
                {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
              </span>
              <button style={styles.rescanBtn} onClick={scanWallet} disabled={scanning}>
                <RefreshCw size={13} />
              </button>
            </div>
          ) : (
            <button style={styles.connectBtn} onClick={connectWallet}>
              <Wallet size={14} />
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <main style={styles.main}>
        {/* Global error */}
        {globalError && (
          <div style={styles.errorBanner}>
            <AlertTriangle size={15} />
            <span>{globalError}</span>
            <button onClick={() => setGlobalError(null)} style={styles.closeBtn}>
              <X size={13} />
            </button>
          </div>
        )}

        {/* Hero block – no wallet */}
        {!walletAddress && (
          <div style={styles.hero}>
            <div style={styles.heroGlow} />
            <div style={styles.heroGrid} />
            <p style={styles.heroLabel}>DUST SCANNER · BURN ENGINE · SWAP KIT</p>
            <h1 style={styles.heroTitle}>
              Clean your<br />
              <span style={styles.heroAccent}>NFT wallet.</span>
            </h1>
            <p style={styles.heroSub}>
              Scan for worthless NFTs. Recycle bids into USDC.<br />
              Burn the rest. Powered by Arc Network.
            </p>
            <button style={styles.heroBtn} onClick={connectWallet}>
              <Scan size={16} />
              Start Scanning
              <ChevronRight size={16} />
            </button>

            <div style={styles.statsRow}>
              {[
                ["10%", "Protocol fee"],
                ["90%", "You receive"],
                ["Arc", "Powered by"],
              ].map(([val, label]) => (
                <div key={label} style={styles.statCard}>
                  <span style={styles.statVal}>{val}</span>
                  <span style={styles.statLabel}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scanning spinner */}
        {scanning && (
          <div style={styles.scannerState}>
            <Loader2 size={32} color="#00ffcc" style={{ animation: "spin 1s linear infinite" }} />
            <p style={styles.scanText}>Scanning wallet via Reservoir…</p>
          </div>
        )}

        {/* NFT Grid */}
        {walletAddress && !scanning && nfts.length > 0 && (
          <>
            {/* Toolbar */}
            <div style={styles.toolbar}>
              <div style={styles.toolbarLeft}>
                <span style={styles.nftCount}>{nfts.length} tokens found</span>
                <button style={styles.tinyBtn} onClick={selectAll}>Select All</button>
                {selectedIds.size > 0 && (
                  <button style={styles.tinyBtn} onClick={clearAll}>Clear</button>
                )}
              </div>
              {selectedIds.size > 0 && (
                <button style={styles.actionBulkBtn} onClick={handleBulkAction}>
                  <Zap size={14} />
                  Process {selectedIds.size} selected
                </button>
              )}
            </div>

            {/* Grid */}
            <div style={styles.grid}>
              {nfts.map((nft) => {
                const key = `${nft.contract}-${nft.tokenId}`;
                const action = actions[key];
                const isSelected = selectedIds.has(key);
                const { userGet, fee } = nft.topBidUSDC ? calcSplit(nft.topBidUSDC) : { userGet: 0, fee: 0 };

                return (
                  <div
                    key={key}
                    style={{
                      ...styles.card,
                      ...(isSelected ? styles.cardSelected : {}),
                      ...(action?.status === "success" ? styles.cardDone : {}),
                    }}
                    onClick={() => !action || action.status === "idle" ? toggleSelect(key) : undefined}
                  >
                    {/* Selection checkbox */}
                    <div style={{ ...styles.checkbox, ...(isSelected ? styles.checkboxOn : {}) }}>
                      {isSelected && <CheckCircle2 size={14} color="#00ffcc" />}
                    </div>

                    {/* Image */}
                    <div style={styles.imgWrap}>
                      {nft.image ? (
                        <img src={nft.image} alt={nft.name} style={styles.img} />
                      ) : (
                        <div style={styles.imgPlaceholder}>
                          <Shield size={28} color="#333" />
                        </div>
                      )}
                      {/* Bid / No-bid badge */}
                      <div style={{ ...styles.bidBadge, background: nft.hasBid ? "#00ffcc22" : "#ff224422", color: nft.hasBid ? "#00ffcc" : "#ff6655" }}>
                        {nft.hasBid ? "HAS BID" : "NO BID"}
                      </div>
                    </div>

                    {/* Info */}
                    <div style={styles.cardBody}>
                      <p style={styles.cardCollection}>{nft.collection}</p>
                      <p style={styles.cardName}>{nft.name}</p>

                      {nft.hasBid && nft.topBidUSDC && (
                        <div style={styles.splitInfo}>
                          <div style={styles.splitRow}>
                            <span style={styles.splitLabel}>You receive</span>
                            <span style={styles.splitUser}>{userGet} USDC</span>
                          </div>
                          <div style={styles.splitRow}>
                            <span style={styles.splitLabel}>Protocol (10%)</span>
                            <span style={styles.splitFee}>{fee} USDC</span>
                          </div>
                        </div>
                      )}

                      {/* Status / CTA */}
                      {action?.status === "pending" && (
                        <div style={styles.statusRow}>
                          <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "#00ffcc" }} />
                          <span style={{ color: "#00ffcc", fontSize: 12 }}>Processing…</span>
                        </div>
                      )}

                      {action?.status === "success" && (
                        <div style={styles.statusRow}>
                          <CheckCircle2 size={13} color="#00ffcc" />
                          <span style={{ color: "#00ffcc", fontSize: 12 }}>
                            {action.type === "recycle" ? `${action.usdcOut} USDC received` : "Burned ✓"}
                          </span>
                        </div>
                      )}

                      {action?.status === "error" && (
                        <div style={styles.statusRow}>
                          <AlertTriangle size={13} color="#ff6655" />
                          <span style={{ color: "#ff6655", fontSize: 11 }}>{action.error}</span>
                        </div>
                      )}

                      {(!action || action.status === "idle" || action.status === "error") && (
                        <div style={styles.cardActions}>
                          {nft.hasBid ? (
                            <button
                              style={styles.recycleBtn}
                              onClick={(e) => { e.stopPropagation(); handleRecycle(nft); }}
                            >
                              <RefreshCw size={12} />
                              Recycle
                            </button>
                          ) : (
                            <button
                              style={styles.burnBtn}
                              onClick={(e) => { e.stopPropagation(); handleBurn(nft); }}
                            >
                              <Flame size={12} />
                              Burn
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Empty state */}
        {walletAddress && !scanning && nfts.length === 0 && (
          <div style={styles.emptyState}>
            <CheckCircle2 size={40} color="#00ffcc" />
            <p style={styles.emptyTitle}>Wallet is clean.</p>
            <p style={styles.emptySub}>No NFTs detected in this wallet.</p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer style={styles.footer}>
        <span>NFT Cleaner Protocol</span>
        <span style={{ color: "#333" }}>·</span>
        <span>Treasury: {TREASURY.slice(0, 10)}…</span>
        <span style={{ color: "#333" }}>·</span>
        <span>Arc Network</span>
      </footer>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: #080b0e;
          color: #c4cdd8;
          font-family: 'Rajdhani', sans-serif;
        }

        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.4 } }
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ─── ERC-721 safeTransferFrom ABI encode (minimal) ───────────────────────────
function encodeERC721Transfer(from: string, to: string, tokenId: bigint): `0x${string}` {
  // safeTransferFrom(address,address,uint256) selector = 0x42842e0e
  const selector = "42842e0e";
  const pad = (hex: string) => hex.padStart(64, "0");
  const addr = (a: string) => pad(a.toLowerCase().replace("0x", ""));
  const uint = (n: bigint) => pad(n.toString(16));
  return `0x${selector}${addr(from)}${addr(to)}${uint(tokenId)}`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "#080b0e",
    fontFamily: "'Rajdhani', sans-serif",
    position: "relative",
    overflow: "hidden",
  },
  scanlines: {
    pointerEvents: "none",
    position: "fixed",
    inset: 0,
    background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,204,0.015) 2px, rgba(0,255,204,0.015) 4px)",
    zIndex: 9999,
  },
  header: {
    borderBottom: "1px solid #0f1a1a",
    background: "rgba(8,11,14,0.95)",
    backdropFilter: "blur(12px)",
    position: "sticky",
    top: 0,
    zIndex: 100,
  },
  headerInner: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "14px 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  logoText: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 16,
    letterSpacing: "0.15em",
    color: "#ffffff",
    fontWeight: 700,
  },
  logoBadge: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 9,
    letterSpacing: "0.2em",
    color: "#00ffcc",
    background: "#00ffcc11",
    border: "1px solid #00ffcc33",
    padding: "2px 7px",
    borderRadius: 2,
  },
  walletPill: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#0d1a16",
    border: "1px solid #00ffcc33",
    borderRadius: 4,
    padding: "6px 12px",
  },
  walletDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#00ffcc",
    boxShadow: "0 0 6px #00ffcc",
    animation: "pulse 2s infinite",
  },
  walletAddr: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 13,
    color: "#00ffcc",
    letterSpacing: "0.05em",
  },
  rescanBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#00ffcc88",
    display: "flex",
    alignItems: "center",
    padding: 0,
    marginLeft: 4,
  },
  connectBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#00ffcc",
    color: "#080b0e",
    border: "none",
    borderRadius: 4,
    padding: "8px 16px",
    fontFamily: "'Rajdhani', sans-serif",
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: "0.08em",
    cursor: "pointer",
  },
  main: {
    flex: 1,
    maxWidth: 1200,
    margin: "0 auto",
    padding: "40px 24px",
    width: "100%",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#ff224411",
    border: "1px solid #ff224444",
    borderRadius: 4,
    padding: "12px 16px",
    marginBottom: 24,
    color: "#ff6655",
    fontSize: 14,
  },
  closeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#ff6655",
    marginLeft: "auto",
    display: "flex",
  },
  hero: {
    position: "relative",
    textAlign: "center",
    padding: "80px 24px 60px",
    animation: "fadeIn 0.6s ease both",
  },
  heroGlow: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%,-50%)",
    width: 600,
    height: 400,
    background: "radial-gradient(ellipse, rgba(0,255,204,0.06) 0%, transparent 70%)",
    pointerEvents: "none",
  },
  heroGrid: {
    position: "absolute",
    inset: 0,
    backgroundImage: "linear-gradient(rgba(0,255,204,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,204,0.03) 1px, transparent 1px)",
    backgroundSize: "40px 40px",
    pointerEvents: "none",
  },
  heroLabel: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.25em",
    color: "#00ffcc88",
    marginBottom: 20,
    position: "relative",
  },
  heroTitle: {
    fontSize: 64,
    fontWeight: 700,
    lineHeight: 1.05,
    color: "#ffffff",
    letterSpacing: "-0.01em",
    marginBottom: 20,
    position: "relative",
  },
  heroAccent: {
    color: "#00ffcc",
    textShadow: "0 0 40px rgba(0,255,204,0.4)",
  },
  heroSub: {
    fontSize: 17,
    color: "#6a7f8a",
    lineHeight: 1.7,
    marginBottom: 36,
    position: "relative",
  },
  heroBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    background: "transparent",
    border: "1px solid #00ffcc",
    color: "#00ffcc",
    padding: "14px 28px",
    borderRadius: 4,
    fontFamily: "'Rajdhani', sans-serif",
    fontWeight: 700,
    fontSize: 16,
    letterSpacing: "0.1em",
    cursor: "pointer",
    marginBottom: 48,
    position: "relative",
    textTransform: "uppercase",
    transition: "background 0.2s, box-shadow 0.2s",
  },
  statsRow: {
    display: "flex",
    justifyContent: "center",
    gap: 24,
    position: "relative",
  },
  statCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    background: "#0d1117",
    border: "1px solid #1a2830",
    borderRadius: 6,
    padding: "16px 28px",
    minWidth: 100,
  },
  statVal: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 22,
    color: "#00ffcc",
    fontWeight: 700,
  },
  statLabel: {
    fontSize: 11,
    color: "#445566",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
  },
  scannerState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
    padding: "80px 0",
  },
  scanText: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 13,
    color: "#00ffcc88",
    letterSpacing: "0.1em",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
    padding: "12px 0",
    borderBottom: "1px solid #0f1a1a",
  },
  toolbarLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  nftCount: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 13,
    color: "#445566",
    letterSpacing: "0.05em",
  },
  tinyBtn: {
    background: "none",
    border: "1px solid #1a2830",
    color: "#6a7f8a",
    padding: "4px 10px",
    borderRadius: 3,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "'Rajdhani', sans-serif",
    fontWeight: 600,
    letterSpacing: "0.05em",
  },
  actionBulkBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#00ffcc",
    color: "#080b0e",
    border: "none",
    borderRadius: 4,
    padding: "8px 18px",
    fontFamily: "'Rajdhani', sans-serif",
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: "0.06em",
    cursor: "pointer",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
    gap: 16,
    animation: "fadeIn 0.4s ease both",
  },
  card: {
    background: "#0b0f14",
    border: "1px solid #131d25",
    borderRadius: 6,
    overflow: "hidden",
    cursor: "pointer",
    transition: "border-color 0.15s, transform 0.15s",
    position: "relative",
  },
  cardSelected: {
    borderColor: "#00ffcc55",
    boxShadow: "0 0 0 1px #00ffcc22 inset",
  },
  cardDone: {
    opacity: 0.5,
    filter: "grayscale(0.5)",
    cursor: "default",
  },
  checkbox: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: 3,
    border: "1px solid #1a2830",
    background: "#080b0e",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  checkboxOn: {
    borderColor: "#00ffcc",
    background: "#00ffcc11",
  },
  imgWrap: {
    position: "relative",
    width: "100%",
    aspectRatio: "1",
    background: "#0d1117",
  },
  img: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  imgPlaceholder: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0d1117",
  },
  bidBadge: {
    position: "absolute",
    bottom: 8,
    left: 8,
    padding: "2px 8px",
    borderRadius: 2,
    fontSize: 9,
    fontFamily: "'Share Tech Mono', monospace",
    letterSpacing: "0.15em",
    fontWeight: 700,
    border: "1px solid currentColor",
  },
  cardBody: {
    padding: "12px 14px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  cardCollection: {
    fontSize: 11,
    color: "#445566",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cardName: {
    fontSize: 15,
    fontWeight: 600,
    color: "#c4cdd8",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    marginBottom: 4,
  },
  splitInfo: {
    background: "#0d1117",
    border: "1px solid #131d25",
    borderRadius: 4,
    padding: "8px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginBottom: 8,
  },
  splitRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  splitLabel: {
    fontSize: 11,
    color: "#445566",
    letterSpacing: "0.04em",
  },
  splitUser: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 12,
    color: "#00ffcc",
    fontWeight: 700,
  },
  splitFee: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 12,
    color: "#445566",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 0",
  },
  cardActions: {
    display: "flex",
    gap: 8,
    marginTop: 4,
  },
  recycleBtn: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    background: "#00ffcc14",
    border: "1px solid #00ffcc44",
    color: "#00ffcc",
    borderRadius: 4,
    padding: "7px",
    fontFamily: "'Rajdhani', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: "0.08em",
    cursor: "pointer",
    textTransform: "uppercase",
  },
  burnBtn: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    background: "#ff224414",
    border: "1px solid #ff224444",
    color: "#ff6655",
    borderRadius: 4,
    padding: "7px",
    fontFamily: "'Rajdhani', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: "0.08em",
    cursor: "pointer",
    textTransform: "uppercase",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
    padding: "80px 0",
    animation: "fadeIn 0.4s ease both",
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: "#c4cdd8",
  },
  emptySub: {
    fontSize: 14,
    color: "#445566",
  },
  footer: {
    borderTop: "1px solid #0f1a1a",
    padding: "16px 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 11,
    color: "#223344",
    letterSpacing: "0.08em",
  },
};

// Augment window for Ethereum provider
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
    };
  }
}
