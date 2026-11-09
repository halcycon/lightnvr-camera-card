# Managed by Tailor: nix/javascript.nix
{ pkgs }:
[
  pkgs.nodejs_22 # Match .nvmrc; preserve this version when reviewing Tailor updates.
  pkgs.oxlint
  pkgs.prettier
]
