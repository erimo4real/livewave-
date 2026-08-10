/**
 * Football channel classification + league tagging.
 *
 * The iptv-org playlist has no structured "sport" field — only a category
 * ("Sports", "Undefined", …) that's applied inconsistently (FIFA+ is
 * "Undefined", Real Madrid TV is "Sports"). So this module classifies
 * channels by *name* alone, with explicit deny rules that keep out music
 * and other-sport channels that happen to use football words.
 *
 * A channel is a "Football" channel when football is its primary identity:
 *   - the name uses a football keyword (football, soccer, fútbol, calcio, …)
 *   - it's a football club or league channel (Real Madrid TV, UEFA Champions
 *     League, MUTV, …)
 *   - it's a known football-first network (beIN, GolTV, Premier Sports, …)
 *
 * Multi-sport networks (ESPN, DAZN, Sky Sports Main Event, …) are NOT
 * classified as football channels — they carry football but aren't defined
 * by it. They're still findable via search or the Sports category.
 *
 * Everything here is a pure function of the channel name, so it's fully
 * unit-testable in plain Node (no browser APIs).
 */

/** Names that use football words but are NOT football channels. */
const DENY_RE = /anthems|strongman/i; // Stingray Soccer Anthems (music), Strongman Champions League

/** Football keywords — "Sky Sports Football", "Fox Soccer Plus", "Okko Futbol", "FIFA+", "Foot+"… */
const FOOTBALL_RE = /football|soccer|futbol|fútbol|futebol|fussball|calcio|golazo|fifa|foot\b/i;

/** Football club / league channels named after what they broadcast. */
const CLUB_LEAGUE_RE =
  /real madrid|barca tv|^mutv|brøndby|løvinderne|dynamo kyiv|champions league|liga de campeones/i;

/** Football-first networks whose name doesn't literally say "football". */
const NETWORK_RE = /goltv|premier sports|\bbein\b/i; // \b keeps "beIN" from matching inside "wellbeing"

/** Is this channel primarily a football channel? */
export function isFootballChannel(name) {
  if (!name || DENY_RE.test(name)) return false;
  return FOOTBALL_RE.test(name) || CLUB_LEAGUE_RE.test(name) || NETWORK_RE.test(name);
}

/**
 * Ordered league rules: first match wins, so specific clubs/competitions
 * take priority over a generic network match (e.g. "Real Madrid TV" is
 * La Liga, not the Champions League its matches sometimes are).
 */
const LEAGUE_RULES = [
  [/premier league/i, 'Premier League'],
  [/sky sports football/i, 'Premier League'],
  [/^mutv/i, 'Premier League'],
  [/champions league|liga de campeones/i, 'Champions League'],
  [/\bbein\b/i, 'Champions League'],
  [/real madrid|barca tv/i, 'La Liga'],
  [/goltv latin america/i, 'La Liga'],
  [/solocalcio/i, 'Serie A'],
  [/sportdigital/i, 'Bundesliga'],
  [/^foot\+/i, 'Ligue 1'],
  [/brøndby|løvinderne/i, 'Danish Superliga'],
  [/dynamo kyiv/i, 'Ukrainian Premier League'],
];

/**
 * Which league(s) does this football channel carry? Empty for channels
 * without a known league (e.g. FIFA+ is general football, not one league).
 */
export function footballLeagues(name) {
  if (!isFootballChannel(name)) return [];
  for (const [re, league] of LEAGUE_RULES) {
    if (re.test(name)) return [league];
  }
  return [];
}
