{ config, lib, pkgs, ... }:

let
  cfg = config.portableDotfiles;

  autoPlatform =
    if pkgs.stdenv.isDarwin then "darwin"
    else if pkgs.stdenv.isLinux then "linux"
    else throw "portableDotfiles: unsupported platform";

  platform = if cfg.platform == "auto" then autoPlatform else cfg.platform;

  walk = dir: prefix:
    if !builtins.pathExists dir then {}
    else
      lib.foldlAttrs
        (acc: name: kind:
          let
            path = dir + "/${name}";
            key = if prefix == "" then name else "${prefix}/${name}";
          in
            if kind == "directory" then
              acc // (walk path key)
            else if kind == "regular" || kind == "symlink" then
              acc // { "${key}" = path; }
            else
              acc)
        {}
        (builtins.readDir dir);

  common = walk (cfg.root + "/files/common") "";
  os =
    if platform == "wsl" then
      (walk (cfg.root + "/files/linux") "") // (walk (cfg.root + "/files/wsl") "")
    else
      walk (cfg.root + "/files/${platform}") "";
  host =
    if cfg.host == null then {}
    else walk (cfg.root + "/hosts/${cfg.host}") "";
in
{
  options.portableDotfiles = {
    enable = lib.mkEnableOption "portable raw-file dotfiles";

    root = lib.mkOption {
      type = lib.types.path;
      description = "Root of the portable dotfiles tree.";
    };

    platform = lib.mkOption {
      type = lib.types.enum [ "auto" "linux" "darwin" "wsl" ];
      default = "auto";
      description = "Platform overlay. Set wsl explicitly when needed.";
    };

    host = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional host overlay name.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.file = lib.mapAttrs (_: source: { inherit source; }) (common // os // host);
  };
}
