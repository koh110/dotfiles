{ config, lib, pkgs, ... }:

let
  cfg = config.portableZsh;
  root = cfg.root;

  detectedPlatform =
    if pkgs.stdenv.isDarwin then "macos"
    else if pkgs.stdenv.isLinux then "linux"
    else throw "portableZsh: unsupported platform";

  platform = if cfg.platform == "auto" then detectedPlatform else cfg.platform;
  os = if platform == "wsl" then "linux" else platform;

  readOptional = path:
    if builtins.pathExists path then builtins.readFile path else "";

  compose = kind:
    let
      hostFragment =
        if cfg.host == null then ""
        else readOptional (root + "/hosts/${cfg.host}/zsh/${kind}.zsh");

      fragments = [
        (builtins.readFile (root + "/zsh/${kind}/common.zsh"))
        (readOptional (root + "/zsh/${kind}/${os}.zsh"))
      ]
      ++ lib.optional (platform == "wsl") (readOptional (root + "/zsh/${kind}/wsl.zsh"))
      ++ lib.optional (hostFragment != "") hostFragment;
    in
      lib.concatStringsSep "\n\n" (builtins.filter (fragment: fragment != "") fragments) + "\n";
in
{
  options.portableZsh = {
    enable = lib.mkEnableOption "portable raw zsh configuration";

    root = lib.mkOption {
      type = lib.types.path;
      default = ../.;
      description = "Root of the dotfiles repository.";
    };

    platform = lib.mkOption {
      type = lib.types.enum [ "auto" "linux" "macos" "wsl" ];
      default = "auto";
      description = "zsh platform layer. WSL must be selected explicitly.";
    };

    host = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional host layer name.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.file.".zshrc".text = compose "rc";
    home.file.".zshenv".text = compose "env";
  };
}
