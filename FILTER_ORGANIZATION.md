# LM Clipper — Filter & Template Organization (LIVE)

Auto-generated from the shipped config. Mirrors exactly what the app shows.
Main dropdown = workflow order. Modal tabs = alphabetical (browse list).

Markers: `[id] Label` = native filter · `{Name}` = code template · `(P)` = needs combo parser.

============================================================

## BASE

[files] Game Filter
Filter replay metadata


============================================================

## MAIN DROPDOWN — the "+ Add Filter" list (workflow order)

[slpParser] Combo Parser
Parse .slp for combo data

[comboFilter] Combo Filter
Filter parsed combos

[sort] Sort
Sort results

[randomSample] Random Sample
Keep a random handful of clips from the input — set how many you want out

[trim] Trim
Add or remove frames from the start/end of clips

[deduplicate] Deduplicate
Remove duplicate clips (matches by game time, stage, frames, and characters)


============================================================

## MODAL / Kills  (A–Z)

{Early Kills}  (P)
Kills where opponent was below a percent threshold

[earlyQuitOut] Early Quit Out
Finds kills the combo parser misses: the victim is comboed to a lethal percent, then quits out (holds L+R+A+Start) before the stock is actually taken. Emits one clip per game, tagged as a kill.

[edgeguardFilter] Edgeguards Filter
Refine Edgeguards Parser results by their stored metrics (hits, offstage duration, ledge distance, depth, ledge-steals, etc.). Must come after an Edgeguards Parser.

[edgeguard] Edgeguards Parser
Finds kills by edgeguard: the victim is knocked offstage by a hit, attempts to recover in range of the ledge, and is denied — hit back out, ledge-stolen, or forced to land on stage and punished (even killed off the top) — dying without ever recovering in between. Each clip starts at the launching hit (with a configurable lead-in) and is tagged with metrics (recovery attempts, offstage depth, forced-landing reads, clean-putaway timing, etc.) the Edgeguards Filter can refine.

{Kill Confirms}  (P)
Short combos (2-3 hits) that result in a kill

[koDirection] KO Direction
Filter KOs by blast zone direction

{Late Kills}  (P)
Kills where opponent was above a percent threshold

{Single-Hit Kills}  (P)
Kills from a single move (raw KOs)

{Smash Finisher}  (P)
Keep combos that end with a smash attack

{Spike Finisher}  (P)
Keep combos that end with a spike/meteor (dair)

{Zero to Death}  (P)
Combos that started near 0% and ended in a kill

[zeroToDeaths] Zero-to-Deaths
Keep only combos that start near 0% and kill


============================================================

## MODAL / Combos  (A–Z)

{All Aerials}  (P)
Keep combos where every hit is an aerial

{Consecutive Aerials}  (P)
Keep combos with N+ aerial moves in a row

{Contains Move}  (P)
Keep combos containing specific move IDs

{Damage Range}  (P)
Filter combos by total damage dealt

{Ends With Move}  (P)
Keep combos that end with a specific move

{Exclude Move}  (P)
Remove combos containing specific move IDs

{High DPS}  (P)
Keep combos above a damage-per-second threshold

{Long Combos}  (P)
Keep only combos over a frame duration

{Min Unique Moves}  (P)
Require a minimum number of distinct moves

{Move Count}  (P)
Keep combos with at least/at most N of a move

{Move Sequence}  (P)
Keep combos containing moves in a specific order

{No Grabs}  (P)
Remove combos that include grabs

{No Pummels}  (P)
Remove combos that include pummels

[reverse] Reverse Hit
Filter for combos where the Nth hit was a reverse hitbox

{Short Combos}  (P)
Keep only combos under a frame duration

[stageCenter] Stage Center Distance
Keep combos that started within a distance (in pixels) of the stage's center vertical line

{Starts With Move}  (P)
Keep combos that start with a specific move

{Unique Moves Only}  (P)
Keep combos where every move is different


============================================================

## MODAL / Sampling  (A–Z)

{Group & Rank}  (P)
Rank clips within groups and keep top N per group

{Limit Per Matchup}  (P)
Cap clips per character matchup pair

{Limit Per Player}  (P)
Cap the number of clips per player tag

{One Per Game}
Keep only one clip per replay file

{Top N by Damage}  (P)
Keep only the highest-damage combos

{Top N by Hits}  (P)
Keep combos with the most hits


============================================================

## MODAL / Utility  (A–Z)

[afkDetection] AFK Detection
Filter clips where a player had little or no controller input (AFK/idle)

{Clip Duration Range}
Filter clips by frame count duration

[removeStarKOFrames] Cut Star KO
Trim star KO animations from the end of clips

{Date Range}
Filter clips by game date

{Dittos Only}  (P)
Keep only mirror-matchup clips

{Exclude Players}  (P)
Remove clips featuring specific player tags

{Merge Overlapping Clips}
Merge clips from the same game that overlap in time

{Percent Range}  (P)
Filter by opponent start percent

{Remove Dittos}  (P)
Exclude mirror-matchup clips


============================================================

## MODAL / Advanced  (A–Z)

[actionStateFilter] Action State
Filter clips by action states at specific frames

[custom] Custom Code
Run a custom JavaScript function

{Custom Property}  (P)
Add a computed property to each clip for downstream filters

{Frame Data Analysis}
Analyze frame data with SlippiGame (slow — reads .slp files)

{Reverse 3-Stock}
Template for finding reverse 3-stocks via frame data (slow)

{Stage Position Filter}
Filter by player position during the combo


============================================================

## PARKED

[pressure] Pressure Parser
Built but disabled in code (commented out of the registry). Not shown anywhere.

