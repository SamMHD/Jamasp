# Deep dive — outage catch-up, 17–19 Nov (02:25 Dubai, Fri 20 Nov)

Run #81, Thu 19 Nov 22:20Z. Covers the 54 hours in which 23 runs failed
(Tue 17 Nov 09:00Z → Thu 19 Nov 13:00Z). Sources: `items` queried by headline
keyword from 2026-11-17T07:00Z (read_at ignored), 20 article extracts read by
subagents, CNBC quote fields fetched 22:21–22:22Z.

**Bottom line.** Gold closed Thursday at **3627.9** — −231 (−6.0%) from
Monday's row in three sessions — while the 2-year yield *fell* 5.7bp over the
same span and December pricing softened. Rates did not do this. Wednesday was
a dollar/liquidation session and Thursday a de-grossing (Nasdaq −2.25%, bull
steepener, gold −3%). **f(2y) is demoted to a hypothesis and the margin setter
fired: weights move 20/45/35 → 30/40/30 (base / bearish-rates / kinetic).**
The kinetic record worsened without reaching a new class, and gold was bid on
none of it.

## 1. Band `64d07935` — HIT

Tue 17 Nov 21:59:59Z GC row **3851.9**, inside 3760–4000 (Mon row 3859.0 → −7.1;
day 3845.6–3887.4). Breakers that printed inside the window and did not break
the band: **Nvidia** (~21:20Z, beat by $7bn, stock up after hours; rows 3852.2
at 21:50Z → 3851.9 at 21:59Z — no first reaction in gold); the US strike on
Qeshm (relay 20:14Z); retail sales +0.2% in line; S&P −1.3% (under the 2% line).
Lifetime 234/47/11.

## 2. f(2y) — demoted to a hypothesis

| Session | 2y | Gold | Read |
|---|---|---|---|
| Tue 17 | ~4.789, −3.8bp (derived from Wed's 4.804 +1.5bp; the Tue wrap prints no 2y line; 10y 5.09 −2.4bp) | row −7.1 | wrong sign, 0.08 ATR — noise, no count |
| Wed 18 | 4.804, +1.5bp (10y −3.5bp, 30y −4.8bp) | row 3727.8, −124.1 (−3.2%) | right sign, impossible size: 1.4 ATR on 1.5bp with December pricing *softer* (28.5 → 27bp; 50bp odds ~10% → ~5%). Silver −4.8%, copper −3.9%. **Dollar/liquidation session — price-setter session one** |
| Thu 19 | **4.77** (CNBC 5:05pm ET line; wrap 4.766, −3.4bp; 10y 5.05 −1.6bp, 30y 5.406 −0.6bp) | field **3627.9, −114.0 (−3.05%)**; row −99.9 | wrong sign at 1.1–1.25 ATR. Nasdaq −2.25%, S&P −2.02%, DXY 52w high 103.974. Bull steepener with gold DOWN = de-grossing, haven bid in Treasuries (rule 22). **Price-setter session two** |

Net: 2y 4.827 (Mon) → 4.77 = **−5.7bp**; gold 3859.0 → 3627.9 = **−231.1**.
Rule 3: two price-setter sessions in a row demote the standing function. The
stance's pre-written step is honored — **bearish-rates −5 / base +5** — with
the tape test passed on both bases each day (Wed row and wrap; Thu field and
row). The investinglive wraps still name "the higher 2-year" (Wed) as a
headwind; Thursday's own wrap concedes "the late decline in Treasury yields
did little to cushion the metals". The dollar is the one input that agreed
with gold on all three days.

**Second step, separate donor — margin setter met Thursday:** Nasdaq −2.25%
(≥2% down) AND gold −114.0 on the field = −1.25 ATR (ATR14 91.3) →
**base +5 / kinetic −5**. Wednesday did not qualify (Nasdaq +0.42%). Thursday
was a 4.3% high-to-close reversal in the Nasdaq (open +1.55% on the Anthropic
IPO, close on the low at 23,879.2); gold sold with it, not against it.

Both steps use Thursday's tape, but they answer different questions (is rates
the setter? is the haven bid operative under a margin call?) and take from
different donors. Result **30/40/30**; conviction held at 0.45 — a positioning
setter is named per session and gives no function to forecast with.
Bearish-rates stays the plurality: the hiking path is intact, merely not the
thing that moved gold this week.

## 3. Rates lines (a')/(b') — not met, hold

- **Dated figures:** December **27bp** and **62bp over three meetings**
  (investinglive minutes post, Wed 19:03Z; repeated in the Wed wrap); **~5%
  for 50bp, ~61bp over three meetings** (investinglive "Four Fed officials",
  Thu 00:28Z). Prior: 28.5bp / ~10% / 86bp-12m (Fri 13 Nov).
- **12-month figure: none.** CNBC's FedWatch sentence (Wed) says December is
  "fully" priced for a quarter point, January "another move", and "at least
  one additional increase before the end of 2027" — no bp total. The
  three-meeting figure is not substituted for it. The actionforex front page
  carries no dated FedWatch sentence. No Thursday pricing sentence was read.
- (a') needs December ≥32.5bp or 50bp ≥25% or 12-month ≥92.5bp: not met.
  (b') needs December ≤22.5bp or 12-month ≤67.5bp with gold UP: not met.
- **Waller, exact conditional** (CNBC Squawk Box interview, Wed — not a
  speech): "If you're not going to signal this very clearly to markets, you're
  going in January, my view is then you have to go 50 in December." So: 50bp
  *unless* January is clearly signalled — and CNBC notes Chair Warsh opposes
  that kind of guidance. "You might need to, like, shock people"; "three hikes
  plus maybe some more". There is no "100 basis points" sentence in the CNBC
  text; that is MarketWatch's headline arithmetic.
- **Minutes, exact wording:** "A couple of *participants* noted that an
  increase of more than 25 basis points could warrant consideration at the
  next meeting *if incoming inflation data were unfavorable*." The scan's "two
  members" is corrected: participants, and conditional on data. "Some
  participants said market expectations of hikes in December and next year
  were broadly in line with their own view" — an endorsement of what is
  priced, which is why pricing did not firm.
- The market faded Waller: 50bp odds halved the day he called for it.

## 4. Kinetic record by extract — no new class

| Item | What the text supports | Class |
|---|---|---|
| US strike, Qeshm, Tue 17 Nov (Bloomberg via gcaptain) | US warplanes hit one IRGC missile launch site; source is **one unnamed US military official**, no CENTCOM/Trump text; framed as a response to an Iranian strike on a US radar installation in Bahrain | limited-strike class, **×3**; reported, not on record |
| TARA GAS (gcaptain, MarEx) | Panama-flag LPG tanker, UAE-managed; hit 16 Nov ~19:00Z 7nm N of Khasab (UKMTO 208-26, engine-room fire), hit again 17 Nov, abandoned; 24 of 25 rescued, one Indian seafarer missing; still burning and drifting 18 Nov 15:00Z (NAVAREA IX). UKMTO names no weapon; "missile" is India's minister, "IRGC drone" is MarEx unattributed | UKMTO hull-hit, reached. **The scan's "LPG tanker abandoned" and "TARA GAS burning" are one hull** |
| NAVIG8 MESSI — ADNOC L&S (gcaptain, MarEx) | **On-record ADNOC L&S statement:** one crew unaccounted for, 11 injured, evening of 17 Nov; UKMTO "unknown projectile", 13nm N of Khasab. **Not the first UAE-operator text:** ADNOC confirmed another hull on 10 Nov, this hull was hit on 13 Aug, MarEx counts "at least 20" ADNOC vessels struck | operator-confirmed hull-hit, reached; the "11 injured" belongs here |
| Third tanker, 18 Nov 16:45Z | "unknown projectile" 6nm N of Khasab, crew safe (UKMTO delayed alert) | reached |
| Blockade expansion (Reuters via gcaptain) | CENTCOM advisory 18 Nov: ships taking cargo ship-to-ship from blockaded vessels "may be considered to be evading the blockade" | enforcement rule, not an act |
| Mehr, Thu 10:22Z | **IRGC Navy claim:** two supertankers (>4mn bbl) "struck naval mines on the unauthorized route"; unnamed hulls, no UKMTO or operator corroboration | claim |
| Bahrain / Kuwait (Gulf News) | Both militaries report **interceptions** only; the "strike on a US radar in Bahrain" is AP/a US official, not a Bahraini or CENTCOM text | no host-state impact text |
| Riyadh (Gulf News Thu) | PIF Tower "damaged" per **witnesses to AFP**; coalition says it "addressed a missile threat" from the Houthis; no Saudi damage text, no Aramco/oil node | witness report |
| NYT / Channel 12 | "No decision has been made"; Trump "in no rush"; Israel presses a 4–7 day campaign | planning |
| Iran–Oman corridor (Gulf News Thu) | **Tehran half exists** (Ghashghavi 15 Nov, Ghalibaf and Baghaei 16 Nov, Araghchi 17 Nov) for a traffic-separation corridor, unsigned, awaiting a Majlis vote. **No US half** — the US is not a party and is silent | not the co-confirmed format |
| Shenzhen trilateral | **US half:** Trump paraphrased — he and Xi "agreed that Iran should fully reopen the Strait" (investinglive Thu 19:16Z, not verbatim). Joint declaration "made no mention of either war". **Tehran half: none** | venue, no arrangement |

Two things the headline list missed. Three hulls were hit in three days inside
a 7–13nm box north of Khasab, and Kpler puts Mideast oil flows at 15 mb/d,
~64% of pre-war against 97% in October — yet Brent settled 91.95 Wednesday and
trades 92.73. The Iran–Oman corridor read beside the IRGC's "unauthorized
route" language is Tehran administering the Strait on its own terms, not a
de-escalation.

**Falsifier checks (nothing scored early):** `18c962a6` laid-mine — mine
appears only as IRGC/Fars claims, not falsified, but it is the closest
approach yet and the Sat brief checks UKMTO/JMIC before scoring. `ee0a7db3`
US major-combat and `f65f894e` US energy-node — one missile site, limited
class, not falsified. `c699a711` arrangement — no US half anywhere, not
falsified. `cc6c7e69` Houthi supply-node — a tower, witnesses only, not
falsified. `211d83e3` Iraqi crude — no Basra text, not falsified. `a0fb9bef`
Israeli — Lebanon only, not falsified. `3875f5e1` yen — USDJPY 159.64 shows
no discontinuity; no intervention text was searched for in this run, the Sat
brief owns it. `70d52712` (Fri row below 3800) — 172 in the money.

## 5. Tape close-out (Thu 19 Nov)

GC row 22:00:00Z **3627.9** (21:51Z 3624.4); CNBC `@GC.1` 3627.90, −114.00
(−3.05%), day 3620.6–3759.5, prev close 3741.9. 2y 4.77 / 10y 5.05 / 30y
5.406 (5:05pm ET). DXY 103.93, **52w high 103.974 set Thursday**. Brent
(Jan) 92.73, +0.85% (Wed settle 91.95); WTI 83.89 (Wed settle 83.26, −3.2%).
Nasdaq Composite 23,879.2, **−2.25%**; S&P 7,175.83, −2.02%. RSI14 26.5,
Stoch K 4.6, WillR −99.9, ADX 30.3, GVZ 28.7.

**Brent ≤89.5 rule: not met.** Wed settle 91.95, Thu ~92.7; Tuesday "settled
higher" (investing.com headline, level not read, above Wednesday's by
construction). The hull-hit leg and the gold-not-UP leg are both met; Brent is
2.45 above the line. No kinetic step on this rule.

## 6. Stance change and bookings

Stance rewritten in full: **30/40/30**, conviction 0.45. No stabilization
evidence — that is a close back above 3729 (lower Bollinger), then 3800.
Persian note sent to the desk (weights moved). No new prediction: `70d52712`
already carries the direction and the Fri brief writes its band on this stance.

Wakeups: **Waller Fri 13:25Z is welcoming remarks at the National College Fed
Challenge finals** (MarketWatch calendar, fetched 22:23Z) — rule 24, no
deepdive, the 15:00Z scan checks for a relay line. **Deepdive booked Fri
18:15Z** for Cook (17:15Z, venue unlisted) and Trump's White House news
conference (noon ET per investinglive Thu 19:16Z, unverified at primary) — the
last scheduled gate before the weekend blind window.

Filed under `reports/2026/11/` (the repo's dated layout) rather than the bare
`reports/` path in the task text.
