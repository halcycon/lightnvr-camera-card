{
  description = "lightNVR camera card development environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    nix-packages.url = "github:wimpysworld/nix-packages";
    nix-packages.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      nixpkgs,
      nix-packages,
      ...
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-darwin"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      # Tailor owns the generic JavaScript fragment; the project selects Node 22 here.
      nodeOverlay = _final: prev: { nodejs = prev.nodejs_22; };
      # The locked nix-packages input supplies the packaging, but predates Tailor 0.6.
      tailorRelease = {
        x86_64-linux = { target = "linux_amd64"; sha256 = "3397ca9da0ccb36f229c878de08b1c47681d925cf30936236e37f2183c3959ea"; };
        aarch64-linux = { target = "linux_arm64"; sha256 = "1645cbcfcdca9053f2c635a8c3686f1a9b165a7ca5701e93624ea3f5f0369a8b"; };
        aarch64-darwin = { target = "darwin_arm64"; sha256 = "9c3af2a02b05a91e1be71facb3cfaa082373416ea3d6d0d5e8ed0e5d0d0a2eff"; };
      };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; overlays = [ nodeOverlay ]; };
        in
        pkgs.lib.optionalAttrs (builtins.pathExists ./nix/lib/blender.nix) {
          blender-agent-bridge-extension = (import ./nix/lib/blender.nix { inherit pkgs; }).extension;
        }
      );
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; overlays = [ nodeOverlay ]; };
          # Keep the development shell available when Tailor has no package for this system.
          tailorPkgs = nix-packages.packages.${system} or { };
          tailorPackage = tailorPkgs.tailor.overrideAttrs (_old: {
            version = "0.6.0";
            src = pkgs.fetchurl {
              url = "https://github.com/wimpysworld/tailor/releases/download/v0.6.0/tailor_0.6.0_${tailorRelease.${system}.target}.tar.gz";
              sha256 = tailorRelease.${system}.sha256;
            };
          });
        in
        {
          default = pkgs.mkShell {
            shellHook = import ./nix/hooks.nix { inherit pkgs; };
            packages =
              with pkgs;
              [
                actionlint
                gh
                just
              ]
              ++ (if tailorPkgs ? tailor then [ tailorPackage ] else [ ])
              ++ import ./nix/loader.nix { inherit pkgs; };
          };
        }
        //
          pkgs.lib.optionalAttrs
            (system == "x86_64-linux" && builtins.pathExists ./nix/shells/go-ebitengine-android.nix)
            {
              android = import ./nix/shells/go-ebitengine-android.nix { inherit pkgs; };
            }
      );
    };
}
