# Study Roulette: A Stable Randomizer for Study Recruitment Links

This project is intended for situations where multiple studies are simultaneously recruiting from the same recruitment link. So, a link like:

https://example.edu/sr?email=foo@bar.baz&ts=1769010749&cn=2772222584

might redirect to one of:

https://redcap.example.edu/surveys/?s=12345678&email=foo@bar.baz&ts=1769010749&cn=2772222584
https://redcap.example.edu/surveys/?s=abcdef12&email=foo@bar.baz&ts=1769010749&cn=2772222584

This process merges URL parameters, with configuration-provided parameters taking precedence.

This randomization is stable -- the same initial link will randomize to the same target, even if the available list of studies changes.

## Implementation

A serverless TypeScript version that stores mappings in an S3-compatible bucket lives in [`serverless/`](serverless/README.md). It reads the same stored mappings as this one.

This project uses python and fastapi. It does not have a traditional database; it uses text files stored in the filesystem. This should be performant enough for up to a few hundred thousand unique redirect URLs.

Required settings, sent in environment variables:

* `LOOKUP_DIR` a path, must be readable/writable by this process, where we'll store the computed redirects
* `STUDIES_FILE` A path, must be readable by this process, that will list the potential study links in a weighted list

### `STUDIES_FILE`

This is a TOML file containing a `studies` array and a `[fallback]` table. Each study must have `url` and `weight` keys, and may optionally have `note`, `required_params`, and `key_params` keys. Extra keys are ignored.

Example:

```toml
studies = [
    {url = "https://redcap.example.edu/surveys/?s=12345678", weight = 1, note = "Control group", required_params = ["email"], key_params = ["email"]},
    {url = "https://redcap.example.edu/surveys/?s=abcdef12", weight = 2, note = "Treatment group", required_params = ["email", "ts", "cn"], key_params = ["email"]},
]

[fallback]
url = "https://redcap.example.edu/surveys/?s=fa11back"
note = "The registry"
```

Or using the expanded TOML array-of-tables syntax:

```toml
[[studies]]
url = "https://redcap.example.edu/surveys/?s=12345678"
weight = 1
note = "Control group"
required_params = ["email"]
key_params = ["email"]

[[studies]]
url = "https://redcap.example.edu/surveys/?s=abcdef12"
weight = 2
note = "Treatment group"
required_params = ["email", "ts", "cn"]
key_params = ["email"]

[fallback]
url = "https://redcap.example.edu/surveys/?s=fa11back"
note = "The registry"
```

URLs must be valid (have a scheme and host) and parseable by `urllib.parse`.

Weights must be nonnegative numbers. Weights are relative and normalized over the studies a given URL is *eligible* for (see below), so `[1, 0.5]` and `[100, 50]` will behave identically. A weight of 0 is valid and removes the URL from consideration in randomization.

`required_params` lists parameter names that must all be present in an incoming URL for the study to be eligible. A parameter that is present but blank (`?email=`) counts as present. Omitting `required_params` means the study is eligible for every URL.

`key_params` lists the parameters used to key the persistent randomization -- the same values for these parameters always route to the same destination, no matter what the other parameters do. `key_params` must be a subset of `required_params`. Omitting it means the randomization is keyed on all supplied parameters.

The `[fallback]` table is required. It has a `url` and an optional `note`, and must not have `weight`, `required_params`, or `key_params`: the fallback is used exactly when no eligible study has a positive weight, and is always keyed on all supplied parameters. This is the *only* way to reach the fallback -- if you want it in the regular randomization mix, add it as a normal study as well.

An empty `studies` array is valid; every URL then goes to the fallback.

### `LOOKUP_DIR`

Contains a set of files with names as lowercase sha256 hex digests. The contents of each file will be a single URL, optionally terminated with a newline. File contents should be trimmed of whitespace before redirecting to URLs. URL format will not be checked before redirecting.

**Important:** `LOOKUP_DIR` should be on a local filesystem that supports POSIX file locking (e.g., ext4, APFS). Network filesystems (NFS, SMB) may not provide reliable locking semantics and could lead to race conditions.

### Algorithm

* Get the URL parameters
* Build the list of candidate lookup keys: the hash of *all* supplied parameters (the fallback's key, and how every mapping predating `key_params` was stored), plus each study's `key_params` subset where all of those parameters are present. Check the most specific key first (the one with the most parameter names), then study order; the all-params key wins ties
* For each candidate key, look for `LOOKUP_DIR`/`hash`. If a stored mapping is found, merge the current parameters into it (the **stored URL wins** any conflict; see below) and return a 302 to the result
* Otherwise, pick a weighted-random study from the ones this URL is eligible for; if none is eligible with a positive weight, use the fallback
* Merge the URL parameters into the chosen study's URL and store the result in `LOOKUP_DIR`/`hash`, where `hash` is computed from the chosen study's `key_params` subset (all supplied parameters for the fallback)
* Return a 302 to the stored URL

A stored mapping always wins, and its parameters win over the current visit's. Per parameter:

* In the stored URL but missing from the current visit (e.g. a later ts-less link): the stored value is replayed
* In the current visit but not the stored URL: forwarded along
* In both with different values: the stored (first-visit) value wins -- every parameter is frozen at its first-visit value

This means adding a study never re-randomizes a returning visitor, and a returning visitor goes to their stored destination even if their current URL lacks parameters the matched study requires. Editing or deleting existing studies may in some cases let people be re-randomized; that's a known sharp edge.

URLs will be parsed, parameter merged, and generated using python's `urllib` module. The parameter hash format must stay byte-identical across releases -- it keys every stored mapping.

### Routes

#### GET /

Runs the above algorithm, returns a 302 Found if this is found, 404 if there are no parameters, 500 if the algorithm fails for any reason

#### GET /health

Checks to make sure we can read and write to `LOOKUP_DIR` and that `STUDIES_FILE` is readable and well-formed. Always returns a JSON object with the keys `status`, `errors`, and `studies`, plus `fallback` when one is configured.

If things are okay, returns 200 OK with:
- `status` = `"ok"`
- `errors` = `[]`
- `studies` = array of `{url, weight, required_params, key_params?, note?}` objects showing the parsed studies
- `fallback` = `{url, note?}`

If there are errors, returns 500 with:
- `status` = `"error"`
- `errors` = array of error strings
- `studies` = array of any studies that *did* parse correctly

The `studies` array is useful for verifying your TOML file is being parsed correctly.

Since eligibility depends on the incoming URL's parameters, the fraction of redirects going to each study isn't computable in general, so there is no `percent` field by default. Pass URL parameters to `/health` to simulate a recruitment URL: each study gains an `eligible_for_params` boolean, and eligible studies gain a `percent` field showing their normalized weight over the eligible set. For example, `GET /health?email=foo@bar.baz` shows what a new visitor with only an email parameter would be eligible for.

**Note:** If some studies fail to parse but others are valid, `/health` returns 500 (for monitoring purposes) but still lists the valid studies. The `/sr` endpoint will continue to redirect to valid studies even when there are parse errors, ensuring service continuity.

## Troubleshooting

Did a bad redirect wind up in LOOKUP_DIR? Find the file with the bad lookup (use something like `grep`) and edit or delete it.

## Developing

Before comitting changes, make sure `uv run pytest` and `uv run ty check` pass without errors.

## Credits

Written by Nate Vack <njvack@wisc.edu> at the Center for Healthy Minds, UW-Madison.

This work was supported by National Institute of Mental Health under grant 1R01MH139512-01: Optimizing the integration between human and digital support in a meditation app for depression and anxiety

## Copyright

Study Roulette is copyright(c) 2026 Board of Regents of the University of Wisconsin System
