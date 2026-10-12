# Richup.io Strategic Bot

**An experimental, open-source strategy bot for Richup.io — built for testing, learning, and community improvement.**

This project is an attempt to build a strategy-driven browser bot for Richup.io using a Tampermonkey userscript.

The goal is to create a smarter bot that can evaluate property purchases, manage cash, develop properties, make better trading decisions, and eventually handle difficult situations such as negative balances.

**This project is a work in progress.** The strategy engine and browser runtime have automated tests, but live Richup.io integration has not been verified. Some important features are incomplete. Contributions, testing, bug reports, and improvements are welcome.

## Project Goals

- Build a smarter and more strategic Richup.io bot.
- Improve property valuation and purchase decisions.
- Manage cash reserves and avoid unnecessary financial risk.
- Develop complete property groups more intelligently.
- Evaluate incoming trades and eventually generate outgoing offers.
- Recover from negative balances using legal in-game actions.
- Improve jail, auction, and end-of-turn decisions.
- Prevent repeated actions, incorrect clicks, and infinite loops.
- Collect action logs to understand mistakes and improve the strategy.
- Make the project accessible to developers who want to contribute.

## Current Features

- Strategy engine for property valuation and purchasing.
- Cash reserve and financial risk calculations.
- Property development evaluation with even-building checks.
- Incoming trade evaluation logic.
- Jail decision logic.
- Property liquidation planning.
- Browser control panel with dry-run and manual-step modes.
- Basic game-state discovery and player identification.
- Action logging and state-dump functionality.
- Safeguards against ambiguous buttons and repeated actions.
- Export of the observation log for debugging and analysis.

Feature availability and reliability depend on whether the live game state and interface are detected correctly.

## Known Issues and Limitations

This is not a finished or fully verified bot.

- **Live integration:** Real Richup.io game-state detection and button matching have not been verified.
- **Negative balance recovery:** Automatic recovery through mortgages or selling buildings is incomplete.
- **Trading:** Incoming offers can be evaluated, but automatic outgoing trade creation and submission are not implemented.
- **Auctions:** Automated auction bidding is not implemented.
- **Property development:** The strategy engine can recommend development, but automatic building clicks are not implemented.
- **Mortgages and liquidation:** Plans can be calculated, but automatic execution is incomplete.
- **Strategy accuracy:** Some calculations use assumptions based on classic Monopoly rules that may not match Richup.io.
- **Learning and calibration:** The model needs testing against real game observations and improvement from collected logs.

Passing automated tests does not guarantee that the bot will make correct decisions in a real game.

## Installation

1. Install the Tampermonkey browser extension.
2. Open Tampermonkey and create a new userscript.
3. Copy the contents of `richup-strategic-bot.user.js` into the editor.
4. Save the script and open Richup.io.
5. Keep **Dry-run** enabled initially.
6. Use the state probe and state-dump tools to check whether the bot can read the game correctly.
7. Use Evaluate to inspect its decisions and logs.
8. Only consider enabling automatic actions after carefully checking the decisions and confirming that the detected state and buttons are correct.

The interface and installation instructions may change as the project develops.

## Development and Testing

The project includes a strategy engine and browser runtime tests.

The development report records 45 engine tests and 19 runtime tests passing. These tests use simulated states and a simulated browser environment; they do not establish that the bot works correctly on the live website.

If you modify the code, run the available tests and document the results. Test important changes involving purchases, trades, negative balances, button detection, and repeated actions.

Use the test commands and setup documented in the repository. Not every development file may be included in every release.

## How You Can Contribute

Contributions are welcome, including small fixes and larger feature improvements.

**Priority areas:**

1. Verify and improve live Richup.io game-state detection.
2. Fix repeated or incorrect actions.
3. Implement negative-balance recovery.
4. Improve incoming trade evaluation and outgoing trade automation.
5. Implement safe property building and mortgage actions.
6. Develop auction decision-making.
7. Improve the strategy model using real observations.
8. Add tests for bugs and edge cases.
9. Improve documentation, installation, and debugging tools.

### Reporting a Bug

When opening an issue, include:

- What you expected the bot to do.
- What it actually did.
- The game situation and visible button labels.
- Relevant sanitized state dumps and exported logs.
- Steps to reproduce the problem.
- Whether Dry-run or automatic mode was enabled.

Remove personal information, account identifiers, session tokens, and other sensitive data before sharing logs. Never upload browser cookies or authentication credentials.

### Submitting Improvements

1. Fork the repository.
2. Create a branch for your change.
3. Make the smallest practical change.
4. Add or update tests where appropriate.
5. Run the available tests.
6. Submit a pull request explaining the problem, your fix, and its test results.

Please avoid claiming that a feature works on the live site unless it has actually been tested there.

## Safety and Scope

- Dry-run is the recommended starting mode.
- Incorrect state detection can lead to incorrect decisions.
- Do not assume the strategy model perfectly reflects Richup.io rules.
- Use the bot only in ways permitted by the game and its applicable rules.
- This project is independent and is not affiliated with or endorsed by Richup.io.

## License

The project license will be specified in the repository. Until a license is added, do not assume that the code is available for unrestricted reuse or redistribution.

## Help Build It

The current implementation is a starting point, not the final product.

If you can reproduce a bug, improve the strategy, verify the live interface, add tests, or implement a missing feature, your contribution can help move the project forward.

**Fork it, test it, report problems, and help improve the bot.**
