#!/usr/bin/env bash
# Prints the one-time setup link for the phone. The key rides after "#", which browsers never send to a server.
cd "$(dirname "$0")"
key=$(grep '^TOMTOM_KEY=' ../.env | cut -d= -f2)
echo "https://$(gh api user -q .login).github.io/drive/#key=$key"
