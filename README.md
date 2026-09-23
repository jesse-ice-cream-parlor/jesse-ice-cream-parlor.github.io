# Ice Cream Orders

A static ordering and serving-plan site for GitHub Pages.

## Try it locally

Open `/menu/` to set a menu, then use the site root to order and `/plan/` to see the schedule.

The configured `sheets` backend shares data through Google Sheets. For a browser-only demo, temporarily set `backend: "local"` in `config.js`; different devices will not share browser-local data.

## Configure shared storage with Google Sheets

1. Create a Google Sheet for the event data.
2. In the Sheet, open **Extensions > Apps Script**.
3. Paste the contents of `google-sheets-backend.gs` into the Apps Script editor.
4. Click **Deploy > New deployment**.
5. Choose **Web app**.
6. Set **Execute as** to yourself and **Who has access** to **Anyone**.
7. Copy the web app URL.
8. Change `config.js`:

```js
window.APP_CONFIG = {
  backend: "sheets",
  sheetsWebAppUrl: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  supabaseUrl: "",
  supabaseAnonKey: ""
};
```

The first request creates four tabs: `Menus`, `Flavors`, `Orders`, and `OrderItems`. Keep those tab names and header rows unchanged.

The organizer page uses obscurity, not authentication. Anyone who opens `/menu/` can replace the current menu.

Google Sheets sharing is simple and inspectable, but it is not a high-security database. Use it for small events where a public ordering link is acceptable.

## Publish on GitHub Pages

Push these files to a GitHub repository. In **Settings > Pages**, choose **Deploy from a branch**, then select the branch and root folder. GitHub will show the public URL after deployment.

Starting a new event archives the active menu and all of its orders. The organizer page displays archived event dates and order counts; full historical data remains in the Google Sheet.

## Optional Supabase backend

The app still includes Supabase support. To use it instead, create a Supabase project, run `supabase.sql`, and set `backend: "supabase"` with the project URL and anon key in `config.js`.

## Scheduling rules

- One person scoops.
- Each flavor has one unlimited container with its own scoop.
- Quantities are free-form text. A nonblank, nonzero quantity means the bowl wants that flavor.
- Numeric quantities scale scoop time; nonnumeric quantities count as one scoop unit for scheduling.
- Every used container is removed just before the first bowl using that flavor is scooped.
- Every used container is replaced just after the last bowl using that flavor is scooped.
- Removing, replacing, scooping, and delivering each take 10 seconds.
- A bowl is delivered after its final scoop.
- All scoops into a bowl are consecutive; a bowl does not switch back and forth between flavors.
- The primary objective is the shortest possible maximum container outing.
- Tie-break by the shortest maximum time from when that container came out until the bowl is served.
- If still tied, break the tie by the lowest lexicographic order of bowl names in lower case.

All bowl orders are evaluated when there are eight or fewer bowls. For larger events, the planner compares several deterministic heuristics to avoid factorial page-load time.

## Crest assets

The full and minimalist Dabney House crest SVGs come from the [Dabney House crest page](https://dabney.caltech.edu/wiki/doku.php?id=crest). The full version appears beside the site title; the minimalist version is the favicon.