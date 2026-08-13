{
  description = "caterpillar — long-running autonomous coding agent supervisor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            git
            jq
            sops
            age
            kubectl
            kustomize
          ];

          shellHook = ''
            echo "caterpillar dev shell — node $(node --version)"
          '';
        };
      });
}
