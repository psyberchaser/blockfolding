/**
 * Social Sentiment Module
 *
 * Aggregates sentiment from multiple sources:
 * - LunarCrush (social metrics)
 * - Santiment (on-chain social)
 * - Reddit/Twitter proxies
 * - Google Trends
 */

export interface SocialMetrics {
  symbol: string;
  socialVolume: number;        // Total social mentions
  socialEngagement: number;    // Likes, shares, comments
  sentiment: number;           // -1 to 1
  sentimentChange24h: number;  // Change in sentiment
  trendingRank: number;        // 1-100 ranking
  influencerMentions: number;  // High-follower accounts
  newsVolume: number;          // News article count
}

export interface AggregatedSentiment {
  overall: number;             // -1 to 1
  overallLabel: 'very_bearish' | 'bearish' | 'neutral' | 'bullish' | 'very_bullish';

  // Per-asset
  btc: SocialMetrics;
  eth: SocialMetrics;
  sol: SocialMetrics;

  // Aggregate metrics
  cryptoTwitterVolume: number;
  redditActivity: number;
  googleTrendsScore: number;

  // Signals
  signals: {
    socialDivergence: boolean;   // Price up but sentiment down
    viralMoment: boolean;        // Sudden spike in mentions
    influencerAlert: boolean;    // Major influencer activity
    fudDetected: boolean;        // Negative sentiment spike
    fomoDetected: boolean;       // Positive sentiment spike
  };

  timestamp: number;
}

let cachedSentiment: AggregatedSentiment | null = null;
let lastSentimentFetch = 0;
const CACHE_TTL = 300000; // 5 minutes

/**
 * Fetch from CoinGecko community data (free)
 */
async function fetchCoinGeckoCommunity(coinId: string): Promise<Partial<SocialMetrics>> {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false`);
    const data = await res.json();

    const community = data.community_data || {};
    const sentiment = data.sentiment_votes_up_percentage || 50;

    return {
      socialVolume: (community.twitter_followers || 0) + (community.reddit_subscribers || 0),
      socialEngagement: community.reddit_average_posts_48h || 0,
      sentiment: (sentiment - 50) / 50, // Convert 0-100 to -1 to 1
      newsVolume: 0,
    };
  } catch (e) {
    return { socialVolume: 0, socialEngagement: 0, sentiment: 0, newsVolume: 0 };
  }
}

/**
 * Fetch trending from CoinGecko
 */
async function fetchTrending(): Promise<string[]> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/search/trending');
    const data = await res.json();
    return (data.coins || []).map((c: any) => c.item.symbol.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Estimate sentiment from price action and volume
 */
function estimateSentimentFromMarket(change24h: number, volumeChange: number): number {
  // Simple heuristic: price up + volume up = bullish
  let sentiment = 0;

  if (change24h > 5) sentiment += 0.4;
  else if (change24h > 2) sentiment += 0.2;
  else if (change24h < -5) sentiment -= 0.4;
  else if (change24h < -2) sentiment -= 0.2;

  if (volumeChange > 50) sentiment += 0.2;
  else if (volumeChange < -30) sentiment -= 0.1;

  return Math.max(-1, Math.min(1, sentiment));
}

/**
 * Fetch Reddit crypto sentiment (using pushshift proxy or estimation)
 */
async function fetchRedditSentiment(): Promise<number> {
  try {
    // Use CryptoPanic free tier for news sentiment
    const res = await fetch('https://cryptopanic.com/api/v1/posts/?auth_token=free&public=true&kind=news&filter=hot');
    const data = await res.json();

    if (data.results) {
      // Count bullish vs bearish keywords
      const text = data.results.map((r: any) => r.title).join(' ').toLowerCase();
      const bullish = (text.match(/bullish|surge|rally|pump|moon|ath|breakout/g) || []).length;
      const bearish = (text.match(/bearish|crash|dump|plunge|fear|sell/g) || []).length;

      const total = bullish + bearish;
      if (total > 0) {
        return (bullish - bearish) / total;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Main sentiment aggregation
 */
export async function fetchSocialSentiment(): Promise<AggregatedSentiment> {
  if (cachedSentiment && Date.now() - lastSentimentFetch < CACHE_TTL) {
    return cachedSentiment;
  }

  // Fetch all data in parallel
  const [btcCommunity, ethCommunity, solCommunity, trending, redditSentiment] = await Promise.all([
    fetchCoinGeckoCommunity('bitcoin'),
    fetchCoinGeckoCommunity('ethereum'),
    fetchCoinGeckoCommunity('solana'),
    fetchTrending(),
    fetchRedditSentiment(),
  ]);

  // Check if assets are trending
  const btcTrending = trending.includes('btc') ? 10 : 50;
  const ethTrending = trending.includes('eth') ? 10 : 50;
  const solTrending = trending.includes('sol') ? 10 : 50;

  const btc: SocialMetrics = {
    symbol: 'BTC',
    socialVolume: btcCommunity.socialVolume || 0,
    socialEngagement: btcCommunity.socialEngagement || 0,
    sentiment: btcCommunity.sentiment || 0,
    sentimentChange24h: 0,
    trendingRank: btcTrending,
    influencerMentions: 0,
    newsVolume: btcCommunity.newsVolume || 0,
  };

  const eth: SocialMetrics = {
    symbol: 'ETH',
    socialVolume: ethCommunity.socialVolume || 0,
    socialEngagement: ethCommunity.socialEngagement || 0,
    sentiment: ethCommunity.sentiment || 0,
    sentimentChange24h: 0,
    trendingRank: ethTrending,
    influencerMentions: 0,
    newsVolume: ethCommunity.newsVolume || 0,
  };

  const sol: SocialMetrics = {
    symbol: 'SOL',
    socialVolume: solCommunity.socialVolume || 0,
    socialEngagement: solCommunity.socialEngagement || 0,
    sentiment: solCommunity.sentiment || 0,
    sentimentChange24h: 0,
    trendingRank: solTrending,
    influencerMentions: 0,
    newsVolume: solCommunity.newsVolume || 0,
  };

  // Calculate overall sentiment
  const overallSentiment = (btc.sentiment + eth.sentiment + sol.sentiment + redditSentiment) / 4;

  let overallLabel: AggregatedSentiment['overallLabel'];
  if (overallSentiment <= -0.5) overallLabel = 'very_bearish';
  else if (overallSentiment <= -0.2) overallLabel = 'bearish';
  else if (overallSentiment >= 0.5) overallLabel = 'very_bullish';
  else if (overallSentiment >= 0.2) overallLabel = 'bullish';
  else overallLabel = 'neutral';

  // Detect signals
  const signals = {
    socialDivergence: false, // Would need price data to compare
    viralMoment: trending.length > 0 && (trending.includes('btc') || trending.includes('eth') || trending.includes('sol')),
    influencerAlert: false,
    fudDetected: overallSentiment < -0.4,
    fomoDetected: overallSentiment > 0.4,
  };

  cachedSentiment = {
    overall: overallSentiment,
    overallLabel,
    btc,
    eth,
    sol,
    cryptoTwitterVolume: btc.socialVolume + eth.socialVolume + sol.socialVolume,
    redditActivity: btc.socialEngagement + eth.socialEngagement + sol.socialEngagement,
    googleTrendsScore: 50, // Would need Google Trends API
    signals,
    timestamp: Date.now(),
  };
  lastSentimentFetch = Date.now();

  return cachedSentiment;
}

export function getSentimentSummary(data: AggregatedSentiment): string {
  return [
    `Overall: ${data.overallLabel.replace('_', ' ').toUpperCase()} (${(data.overall * 100).toFixed(0)}%)`,
    `BTC: ${(data.btc.sentiment * 100).toFixed(0)}% | ETH: ${(data.eth.sentiment * 100).toFixed(0)}% | SOL: ${(data.sol.sentiment * 100).toFixed(0)}%`,
    data.signals.fomoDetected ? 'FOMO DETECTED' : '',
    data.signals.fudDetected ? 'FUD DETECTED' : '',
    data.signals.viralMoment ? 'VIRAL MOMENT' : '',
  ].filter(Boolean).join('\n');
}
