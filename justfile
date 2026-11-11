# Requires just 1.23.0 or later.
import 'just/loader.just'

# List available recipes
default:
    @just --list

# Use the locked npm tools and optional local CLI bootstrap.
export PATH := justfile_directory() + "/node_modules/.bin:" + justfile_directory() + "/.execution/quality-tools/bin:" + env_var("PATH")
