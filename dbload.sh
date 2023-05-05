echo "Welcome to Sealog dbload"
echo "please input remote sealog server username"

read username

host="harmonyhill"  # sealog machine
vehicle="jason" # vehicle we're using
CRUISE_NUMBER="TN406"   # cruise
DIVE_NUMBER="J2-1438"   # dive
dbdump_path="~/sealog-files/dbdump" # where would you like to stick this?

cruise_file_name="$CRUISE_NUMBER"_cruiseRecord_mod.json

echo "looking for cruise file $cruise_file_name"
mkdir -p $dbdump_path/$CRUISE_NUMBER

echo "rsyncing cruise from harmonyhill"
rsync -r $username@$host:/home/sealog/Cruises/$CRUISE_NUMBER/modifiedForImport/$cruise_file_name $dbdump_path/$CRUISE_NUMBER/$cruise_file_name

echo "rsyncing aux data, events, and lowerings"
rsync -r $username@$host:/home/sealog/Cruises/$CRUISE_NUMBER/$DIVE_NUMBER/modifiedForImport/ $dbdump_path/$CRUISE_NUMBER/

echo "importing into local mongo instance"
mongoimport --db sealogDB --collection cruises --file $dbdump_path/$CRUISE_NUMBER/$cruise_file_name --mode upsert --jsonArray

mongoimport --db sealogDB --collection lowerings --file $dbdump_path/$CRUISE_NUMBER/"$DIVE_NUMBER"_loweringRecord_mod.json --mode upsert --jsonArray
mongoimport --db sealogDB --collection events --file $dbdump_path/$CRUISE_NUMBER/"$DIVE_NUMBER"_eventOnlyExport_mod.json --mode upsert --jsonArray
mongoimport --db sealogDB --collection event_aux_data --file $dbdump_path/$CRUISE_NUMBER/"$DIVE_NUMBER"_auxDataExport_mod.json --mode upsert --jsonArray

exit