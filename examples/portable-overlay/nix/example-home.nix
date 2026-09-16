{ ... }:
{
  imports = [ ./module.nix ];

  portableDotfiles = {
    enable = true;
    root = ../.;
    host = "llm-server";
  };
}
