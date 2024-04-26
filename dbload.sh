#!/bin/bash

echo "Welcome to Sealog dbload"
echo "please input remote sealog server username"

read username

host="harmonyhill"  # sealog machine
vehicle="jason" # vehicle we're using
DEFAULT_CRUISE_NUMBER="TN406"  
DEFAULT_DIVE_NUMBER="J2-1438"

# If positional parameters are provided, override the default values
CRUISE_NUMBER="${1:-$DEFAULT_CRUISE_NUMBER}"
DIVE_NUMBER="${2:-$DEFAULT_DIVE_NUMBER}"
dbdump_path="$HOME/sealog-files/dbdump" # where would you like to stick this?

cruise_file_name="$CRUISE_NUMBER"_cruiseRecord_mod.json

echo "looking for cruise file $cruise_file_name"
mkdir -p $dbdump_path/$CRUISE_NUMBER

echo "rsyncing cruise from harmonyhill"
rsync -r $username@$host:/home/sealog/Cruises/$CRUISE_NUMBER/modifiedForImport/$cruise_file_name $dbdump_path/$CRUISE_NUMBER/$cruise_file_name

echo "rsyncing aux data, events, and lowerings"
rsync -r $username@$host:/home/sealog/Cruises/$CRUISE_NUMBER/$DIVE_NUMBER/modifiedForImport/ $dbdump_path/$CRUISE_NUMBER/


# Function to determine the JSON file type and return the appropriate jsonArray argument
get_json_array_flag() {
  local json_file=$1
  local jsonArray=""

  # Check if the JSON file contains an array
  if head -n 1 "$json_file" | grep -q '^\['; then
    # If it's an array, set the jsonArray variable to "--jsonArray"
    jsonArray="--jsonArray"
  fi

  echo "$jsonArray"
}

echo "importing $dbdump_path/$CRUISE_NUMBER/$cruise_file_name"
jsonArray=$(get_json_array_flag "$dbdump_path/$CRUISE_NUMBER/$cruise_file_name")
mongoimport --db sealogDB --collection cruises --file $dbdump_path/$CRUISE_NUMBER/$cruise_file_name --mode upsert $jsonArray

echo "importing $dbdump_path/$CRUISE_NUMBER/$DIVE_NUMBER""_loweringRecord_mod.json"
jsonArray=$(get_json_array_flag "$dbdump_path/$CRUISE_NUMBER/$DIVE_NUMBER""_loweringRecord_mod.json")
mongoimport --db sealogDB --collection lowerings --file $dbdump_path/$CRUISE_NUMBER/"$DIVE_NUMBER"_loweringRecord_mod.json --mode upsert $jsonArray

echo "importing $dbdump_path/$CRUISE_NUMBER/$DIVE_NUMBER""_eventOnlyExport_mod.json"
jsonArray=$(get_json_array_flag "$dbdump_path/$CRUISE_NUMBER/$DIVE_NUMBER""_eventOnlyExport_mod.json")
mongoimport --db sealogDB --collection events --file $dbdump_path/$CRUISE_NUMBER/"$DIVE_NUMBER"_eventOnlyExport_mod.json --mode upsert $jsonArray

echo "importing $dbdump_path/$CRUISE_NUMBER/$DIVE_NUMBER""_auxDataExport_mod.json"
jsonArray=$(get_json_array_flag "$dbdump_path/$CRUISE_NUMBER/$DIVE_NUMBER""_auxDataExport_mod.json")
mongoimport --db sealogDB --collection event_aux_data --file $dbdump_path/$CRUISE_NUMBER/"$DIVE_NUMBER"_auxDataExport_mod.json --mode upsert $jsonArray

exit
