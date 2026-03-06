/**
 * LLM Chat Interface for Trading Signals
 *
 * Allows natural language queries about:
 * - Early alpha opportunities
 * - Market signals and predictions
 * - Smart money activity
 * - Token analysis
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  getNewTokens,
  getLiquidityEvents,
  getSmartMoneyTrades,
  getSmartMoneyWallets,
  getSocialSignals,
  getEarlyAlphaSignals,
  computeEarlyAlphaScore,
  type NewToken,
  type LiquidityEvent,
  type EarlyAlphaSignal,
} from './earlyAlpha.js';

// ============================================
// TYPES
// ============================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  message: string;
  data?: any;
  suggestions?: string[];
}

// ============================================
// LLM CLIENT
// ============================================

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// ============================================
// CONTEXT BUILDER
// ============================================

function buildContext(): string {
  const tokens = getNewTokens(20);
  const pairs = getLiquidityEvents(20);
  const smartMoney = getSmartMoneyTrades(10);
  const wallets = getSmartMoneyWallets();
  const social = getSocialSignals(10);
  const signals = getEarlyAlphaSignals(10);

  // Build a summary of current data
  const context = `
## Current Market Data Summary

### New Tokens (Last 20)
${tokens.length > 0 ? tokens.map(t => `- ${t.symbol || 'Unknown'} (${t.address.slice(0, 10)}...): Score ${t.score}, ${t.signals.join(', ')}`).join('\n') : 'No new tokens detected yet.'}

### Recent Liquidity Events
${pairs.length > 0 ? pairs.map(p => `- ${p.dex}: Pair ${p.pairAddress.slice(0, 10)}... (${p.token0.slice(0, 8)}/${p.token1.slice(0, 8)})`).join('\n') : 'No new pairs detected yet.'}

### Smart Money Wallets Tracked (${wallets.length})
${wallets.map(w => `- ${w.label}: ${w.address.slice(0, 10)}... (Win rate: ${(w.winRate * 100).toFixed(0)}%)`).join('\n')}

### Recent Smart Money Activity
${smartMoney.length > 0 ? smartMoney.map(t => `- ${t.action.toUpperCase()} ${t.token.slice(0, 10)}... by ${t.wallet.slice(0, 8)}... ($${t.amountUSD})`).join('\n') : 'No recent smart money trades detected.'}

### Social Signals
${social.length > 0 ? social.map(s => `- ${s.source}: ${s.token || 'General'} - ${s.mentions} mentions, sentiment ${(s.sentiment * 100).toFixed(0)}%`).join('\n') : 'No social signals collected yet.'}

### Top Early Alpha Signals
${signals.length > 0 ? signals.map(s => `- ${s.symbol || s.token.slice(0, 10)}: Score ${s.score.toFixed(0)}/100, Risk: ${s.risk}, ${s.reasoning.join('; ')}`).join('\n') : 'No early alpha signals yet. Run a scan first.'}
`;

  return context;
}

// ============================================
// SYSTEM PROMPT
// ============================================

const SYSTEM_PROMPT = `You are an expert crypto trading analyst assistant. You help users understand market signals, identify early alpha opportunities, and analyze token deployments.

You have access to real-time data about:
- New token deployments on Ethereum
- DEX liquidity additions (Uniswap V2/V3, Sushiswap)
- Smart money wallet activity
- Social signals from Twitter and other platforms

When users ask about opportunities:
1. Analyze the available data objectively
2. Point out both opportunities AND risks
3. Never give financial advice - present facts and let users decide
4. Be concise but thorough
5. If data is missing, say so and suggest running a scan

When analyzing tokens:
- High score (60+) = Promising signals
- Medium score (30-60) = Mixed signals, needs more research
- Low score (<30) = High risk indicators

Risk levels:
- Low: Multiple positive signals, established liquidity
- Medium: Some positive signals, new but normal deployment
- High: Few positive signals, questionable patterns
- Extreme: Scam indicators detected, avoid

Always include caveats about the speculative nature of new tokens and the importance of DYOR (Do Your Own Research).`;

// ============================================
// CHAT FUNCTION
// ============================================

export async function chat(
  userMessage: string,
  history: ChatMessage[] = []
): Promise<ChatResponse> {
  try {
    const client = getClient();

    // Build context with current market data
    const context = buildContext();

    // Format conversation history
    const messages = [
      ...history.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      {
        role: 'user' as const,
        content: `${userMessage}\n\n---\nCurrent Market Context:\n${context}`,
      },
    ];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const assistantMessage = response.content[0].type === 'text'
      ? response.content[0].text
      : 'I could not generate a response.';

    // Generate follow-up suggestions
    const suggestions = generateSuggestions(userMessage, assistantMessage);

    return {
      message: assistantMessage,
      suggestions,
    };
  } catch (error: any) {
    console.error('[chat] Error:', error);

    if (error.message.includes('ANTHROPIC_API_KEY')) {
      return {
        message: 'Chat is not configured. Please set ANTHROPIC_API_KEY in your environment.',
        suggestions: ['Check environment variables', 'View raw signal data'],
      };
    }

    return {
      message: `Error: ${error.message}`,
      suggestions: ['Try again', 'View raw data'],
    };
  }
}

// ============================================
// QUICK QUERIES (No LLM needed)
// ============================================

export async function quickQuery(query: string): Promise<ChatResponse> {
  const lowerQuery = query.toLowerCase();

  // Handle common queries without LLM
  if (lowerQuery.includes('new tokens') || lowerQuery.includes('recent tokens')) {
    const tokens = getNewTokens(10);
    return {
      message: `Found ${tokens.length} recent tokens:\n\n${
        tokens.map(t => `**${t.symbol || 'Unknown'}** (${t.address.slice(0, 10)}...)\n  Score: ${t.score}/100\n  Signals: ${t.signals.join(', ')}`).join('\n\n') || 'No tokens detected. Try running a scan.'
      }`,
      data: tokens,
      suggestions: ['Scan for more tokens', 'Analyze specific token', 'Check smart money'],
    };
  }

  if (lowerQuery.includes('hot') || lowerQuery.includes('best') || lowerQuery.includes('top')) {
    const signals = getEarlyAlphaSignals(5);
    const hotTokens = getNewTokens(100)
      .filter(t => t.score > 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return {
      message: `**Top Opportunities:**\n\n${
        hotTokens.map(t =>
          `**${t.symbol || 'Unknown'}** - Score: ${t.score}/100\n  ${t.signals.join(', ')}`
        ).join('\n\n') || 'No high-scoring tokens found. Market may be quiet or scan needed.'
      }`,
      data: { hotTokens, signals },
      suggestions: ['Get more details', 'Check liquidity', 'Monitor smart money'],
    };
  }

  if (lowerQuery.includes('smart money') || lowerQuery.includes('whales')) {
    const wallets = getSmartMoneyWallets();
    const trades = getSmartMoneyTrades(10);

    return {
      message: `**Smart Money Tracking:**\n\nWallets: ${wallets.length}\n${
        wallets.map(w => `- ${w.label}: ${(w.winRate * 100).toFixed(0)}% win rate`).join('\n')
      }\n\n**Recent Activity:**\n${
        trades.length > 0
          ? trades.map(t => `${t.action.toUpperCase()} ${t.token.slice(0, 10)}... ($${t.amountUSD})`).join('\n')
          : 'No recent trades detected'
      }`,
      data: { wallets, trades },
      suggestions: ['Add wallet to track', 'Filter by wallet', 'View trade history'],
    };
  }

  if (lowerQuery.includes('liquidity') || lowerQuery.includes('pairs')) {
    const pairs = getLiquidityEvents(10);

    return {
      message: `**Recent Liquidity Events:**\n\n${
        pairs.map(p =>
          `${p.dex}: ${p.token0.slice(0, 8)}/${p.token1.slice(0, 8)}\n  Pair: ${p.pairAddress.slice(0, 12)}...`
        ).join('\n\n') || 'No new pairs detected. Try running a scan.'
      }`,
      data: pairs,
      suggestions: ['Scan for new pairs', 'Check token liquidity', 'View Uniswap pools'],
    };
  }

  if (lowerQuery.includes('scan') || lowerQuery.includes('search')) {
    return {
      message: 'To scan for new opportunities, use the `/trading-bot/early-alpha/scan` endpoint with POST request, or click "Start Scanner" in the dashboard.',
      suggestions: ['Start scanner', 'View current data', 'Check status'],
    };
  }

  // If no quick match, fall back to LLM if available
  if (process.env.ANTHROPIC_API_KEY) {
    return chat(query);
  }

  // No LLM available, provide basic response
  return {
    message: `I can help you with:\n- **new tokens** - See recent token deployments\n- **hot tokens** - View highest-scoring opportunities\n- **smart money** - Track whale wallets\n- **liquidity** - View new DEX pairs\n- **scan** - Start scanning for opportunities\n\nFor advanced analysis, configure ANTHROPIC_API_KEY.`,
    suggestions: ['Show new tokens', 'Show hot tokens', 'Track smart money'],
  };
}

// ============================================
// ANALYZE TOKEN
// ============================================

export async function analyzeToken(address: string): Promise<ChatResponse> {
  try {
    const signal = await computeEarlyAlphaScore(address);

    if (!signal) {
      return {
        message: `Could not analyze token ${address}. It may not be deployed or not an ERC20 token.`,
        suggestions: ['Try another address', 'Scan for new tokens'],
      };
    }

    const analysis = `**Token Analysis: ${signal.symbol || signal.token.slice(0, 12)}**

**Score:** ${signal.score.toFixed(0)}/100
**Risk Level:** ${signal.risk.toUpperCase()}
**Confidence:** ${(signal.confidence * 100).toFixed(0)}%

**Signals:**
${signal.reasoning.map(r => `- ${r}`).join('\n')}

**Deployment Info:**
${signal.signals.deployment
  ? `- Deployed at block ${signal.signals.deployment.blockNumber}\n- Deployer: ${signal.signals.deployment.deployer.slice(0, 12)}...`
  : '- No deployment data (may be older token)'}

**Liquidity:**
${signal.signals.liquidity.length > 0
  ? signal.signals.liquidity.map(l => `- ${l.dex}: $${l.liquidityUSD.toFixed(0)}`).join('\n')
  : '- No liquidity events detected'}

**Smart Money:**
${signal.signals.smartMoney.length > 0
  ? `- ${signal.signals.smartMoney.filter(t => t.action === 'buy').length} buys detected`
  : '- No smart money activity detected'}

**Social:**
${signal.signals.social.length > 0
  ? `- ${signal.signals.social[0].mentions} mentions, ${(signal.signals.social[0].sentiment * 100).toFixed(0)}% sentiment`
  : '- No social signals'}

---
*Note: This is automated analysis. Always DYOR before trading.*`;

    return {
      message: analysis,
      data: signal,
      suggestions: ['Check liquidity', 'Monitor this token', 'Find similar tokens'],
    };
  } catch (error: any) {
    return {
      message: `Error analyzing token: ${error.message}`,
      suggestions: ['Try again', 'Check address format'],
    };
  }
}

// ============================================
// HELPERS
// ============================================

function generateSuggestions(query: string, response: string): string[] {
  const suggestions: string[] = [];

  if (response.includes('scan') || response.includes('no data')) {
    suggestions.push('Run a scan');
  }

  if (response.includes('token') || response.includes('deployment')) {
    suggestions.push('Analyze specific token');
  }

  if (response.includes('smart money') || response.includes('whale')) {
    suggestions.push('Add wallet to track');
  }

  if (response.includes('liquidity') || response.includes('pair')) {
    suggestions.push('Check new pairs');
  }

  // Add generic suggestions if few specific ones
  if (suggestions.length < 2) {
    suggestions.push('Show hot tokens');
    suggestions.push('View dashboard');
  }

  return suggestions.slice(0, 4);
}

// ============================================
// EXPORTS
// ============================================

export function isConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
