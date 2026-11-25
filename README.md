# AgentCrash

AgentCrash is a durable MCP agent runtime plus a crash-point verifier. A TypeScript tool gateway journals every tool call in PostgreSQL, sends an idempotency key with each call and recovers after a crash; a verifier kills the process at every tool-call boundary and compares the effects recorded by independent mock MCP servers with a clean run.

## Problem

## Architecture

## Quick start

## Results (generated)

## Limits