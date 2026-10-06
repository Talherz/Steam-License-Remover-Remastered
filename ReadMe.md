<h1 align = "center">
    <br>
    Steam License Remover
    <br>
    <br>
    <a href="https://ibb.co/D55WXk5"><img src="https://i.ibb.co/LnnRw6n/Sans-titre-modified.png" alt="Sans-titre-modified" border="0"></a>
    <br>
    <br>
    Version: 3.2
    <br>
</h1>





# Description:

**Note: This is a heavily updated and remastered fork of the original script by IroN404 and Beardox.**

This Script will remove any "Free" games from your Steam Library by removing the game's license from your account. In this way, these games will no longer appear in your library.

### New Features in Remastered Version (v3.2):
- **Adaptive Pacing:** Automatically adjusts the delay between requests to avoid Steam rate limits (Error 84), settling just above Steam's actual refill interval.
- **Improved Error Handling:** Non-retryable licenses (like Free Weekend games) are skipped automatically.
- **Enhanced Telemetry & Logging:** Tracks successes and rate limits to analyze runs and export data.
- **Pagination Support:** Automatically crawls through all license pages.
- **Verification:** Built-in tool to verify that removed licenses are actually gone.

# Usage:

1. Copy the script to your clipboard.
2. Open your browser and go to https://store.steampowered.com/account/licenses/
3. Open the developer console (F12)
4. Paste the script into the console and press enter.
5. Review the summary table and confirm to start the removal process. Keep the tab in the foreground (or in its own window) while it runs.
6. Once finished, use the command `SLR.verify()` to ensure everything was removed successfully.

### Console Commands (New!):
You can interact with the script during or after execution using these console commands:
- `SLR.status()` - Live progress and current pace.
- `SLR.stop()` - Stop after the current step.
- `SLR.report()` - Rate-limit analysis across ALL runs (`SLR.report('run')` for this run only).
- `SLR.exportCSV()` - Download every logged event as a CSV.
- `SLR.exportJSON()` - Download raw telemetry and report as JSON.
- `SLR.verify()` - Re-check the licenses page and confirm removals.
- `SLR.reset()` - Forget saved progress (removed IDs) for this account.
- `SLR.clearLog()` - Wipe telemetry for this account.

# Notes:

- This script will not remove any games that you have purchased.
- This script will not remove any games that you have been gifted.

# Disclaimer:

- This script is provided as is. I am not responsible for any damage that may occur to your account. Use at your own risk.
- Don't change the script, especially the interval time, if you do, your browser's access to your profile settings page may be blocked by Steam for a few seconds or minutes.


# Changelog:

 - 3.2 - Added continuationToken support for pagination. Improved error handling for DuplicateRequest (error 29). Added adaptive pacing to handle Steam's dynamic rate limiting.
 - 3.x - Forked & Remastered! Added comprehensive telemetry, error checking, and API analysis.
 - 1.1 - Added a delay between each request to avoid being blocked by Steam.
 - 1.0 - Initial Release

# Credits:

- **Original Creator:** IroN404
- **Fork / Initial updates:** Beardox
- **Remastered By:** Talha Chughtai
- SteamDB - https://steamdb.info/