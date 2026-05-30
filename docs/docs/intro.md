---
id: intro
title: Introduction
slug: /
sidebar_position: 1
---

# Kryon Protocol

Kryon is a decentralised perpetual-futures exchange built on **Stellar / Soroban**.
It pairs an on-chain margin engine and settlement layer with an off-chain
central-limit order book (CLOB) matcher, giving traders a familiar
low-latency perp experience while keeping custody, margin, and settlement
fully on-chain.

## What this documentation covers

This is the engineering reference for the entire Kryon stack — contracts,
execution engine, services, frontend, data layer, APIs, and operations. It is
written for engineers building on, operating, or auditing the protocol.

| Section | What you'll find |
| --- | --- |
| [Architecture](/architecture/protocol) | System topology, Soroban contracts, frontend & backend design, infra |
| [Trading](/trading/lifecycle) | The full trade lifecycle, execution engine, order lifecycle, PnL & funding |
| [Data & Analytics](/data/database) | Database schema, leaderboard system, portfolio tracking |
| [APIs](/api/rest) | REST endpoints and the streaming/WebSocket contract |
| [Operations](/operations/local-dev) | Local dev, environment setup, onboarding, deployment |
| [Security](/security) & [Scaling](/scaling) | Threat model, trust assumptions, scaling strategy |
| [Stress-Test Report](/stress-test-report) | Findings and fixes from production hardening |
| [Mainnet Readiness](/mainnet-readiness) | Honest gap analysis for mainnet launch |

## Design at a glance

```
                        ┌─────────────────────────┐
   Trader (Freighter)   │      Next.js frontend    │
        │               │  trade · portfolio · LB  │
        │  sign orders  └───────────┬─────────────┘
        ▼                           │ REST (same-origin /api/*)
┌──────────────────┐                ▼
│  Order intents   │      ┌───────────────────────┐
│  (off-chain DB)  │◀────▶│   Next.js API routes   │──▶ Neon Postgres
└────────┬─────────┘      └───────────────────────┘
         │ poll 1s
         ▼
┌──────────────────┐   settle_fill (operator-signed)   ┌──────────────────┐
│  Matcher service │ ────────────────────────────────▶ │  Soroban engine  │
│  (price-time)    │                                    │  vault · oracle  │
└──────────────────┘                                    └──────────────────┘
         ▲                                                       │
         │ state sync (positions, OI, funding, stats)            │
┌──────────────────┐                                             │
│  State indexer   │◀────────────────────────────────────────────┘
└──────────────────┘
```

- **On-chain (Soroban):** vault (collateral), engine (positions, margin,
  funding), oracle adapter (prices), order gateway (settlement), liquidation,
  insurance, risk, governance.
- **Off-chain services:** the **matcher** (CLOB matching + automatic
  operator-signed settlement), the **oracle keeper** (publishes prices), and
  the **state indexer** (syncs chain state + computes leaderboard/portfolio
  analytics).
- **Frontend:** Next.js 16 (App Router, React 19) trading terminal,
  portfolio, and leaderboard.

## Network

The reference deployment targets **Stellar testnet**. Live contract addresses
are listed in [Soroban Contracts](/architecture/contracts). Mainnet launch
prerequisites are tracked in [Mainnet Readiness](/mainnet-readiness).
