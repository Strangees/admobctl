---
type: llm
weight: 2
---

The answer identifies "Quiz banner (Android)" as having low fill (about 20% match rate on 40,000 requests) and
"Timer banner" as having a low show rate (about 31%), citing those numbers from the insights tool output.
Simple arithmetic on those numbers (shares, differences) is fine. Fail if it states metrics that are not in or derivable
from the tool output, presents industry benchmarks as facts about the user's account, or names ad units that are not
in the data. It gives at least one concrete next step per problem (e.g. check mediation, floors or request frequency
for fill; check when ads are loaded vs shown for show rate).
