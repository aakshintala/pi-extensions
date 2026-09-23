# pi-rig

Customized Pi extensions maintained as a lightweight monorepo. Every extension is rebuilt here from a behaviour spec; vendored upstream source is kept for reference and never loaded by Pi.

## Install

```sh
pi install /path/to/pi-rig
```

## Extensions

| Extension | What it is for | Spec |
|---|---|---|
| [ponytail](extensions/ponytail/README.md) | Always-on guidance to build the simplest working solution, plus the `ponytail-audit` skill | [#37](https://github.com/aakshintala/pi-rig/issues/37) |
| [status](extensions/status/README.md) | Quota headroom from QuotaBar.app via `get_quotas` and `/quota` | [#38](https://github.com/aakshintala/pi-rig/issues/38) |
