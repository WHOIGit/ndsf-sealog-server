#!/bin/bash
#
# Purpose: This script backs up all the lowerings for a cruise
#
#   Usage: Type sealog_postdive.sh [-d dest_dir] <cruise_id> to run the script.
#          - [-d dest_dir] --> where to save the data, the default location
#                              is defined in the BACKUP_DIR_ROOT variable
#          - <dest_id>     --> the cruise ID (RR1802)
#
#  Author: Webb Pinner webbpinner@gmail.com
# Created: 2019-10-08

SCRIPT_BASE=`dirname $0`

GET_CRUISE_UID_SCRIPT='python3 '${SCRIPT_BASE}'/sealog-utils-getCruiseUid.py'
GET_LOWERING_IDS_SCRIPT='python3 '${SCRIPT_BASE}'/sealog-utils-getLoweringIdsByCruise.py'
BACKUP_LOWERING_SCRIPT=${SCRIPT_BASE}'/sealog_postdive.sh'

# Root data folder for Sealog
BACKUP_DIR_ROOT="/Users/webbpinner/Desktop/sealog-backups"

usage(){
cat <<EOF
Usage: $0 [-?] [-d dest_dir] [-c <cruise_id>
	-d <dest_dir>   Where to store the backup, the default is:
	                ${BACKUP_DIR_ROOT}
	<cruise_id>     The cruise id i.e. 'AT42-01'
EOF
}

while getopts ":d:c:" opt; do
  case $opt in
   d)
      BACKUP_DIR_ROOT=${OPTARG}
      ;;

   \?)
      usage
      exit 0
      ;;
  esac
done

shift $((OPTIND-1))

if [ $# -ne 1 ]; then
        echo ""
        echo "Missing cruise ID"
        echo ""
        usage
        exit 1
fi

CRUISE_ID="${1}"
CRUISE_OID=""

if [ ${CRUISE_ID} != "" ]; then
	CRUISE_OID=`${GET_CRUISE_UID_SCRIPT} ${CRUISE_ID}`

	if [ -z ${CRUISE_OID} ]; then
		echo ""
		echo "Unable to find cruise data for cruise id: ${CRUISE_ID}"
		echo ""
		exit 1
	fi

fi

LOWERING_IDS=(`${GET_LOWERING_IDS_SCRIPT} ${CRUISE_OID}`)
for LOWERING_ID in "${LOWERING_IDS[@]}"
do
	echo "Exporting Lowering:" ${LOWERING_ID}
	${BACKUP_LOWERING_SCRIPT} '-d' ${BACKUP_DIR_ROOT} '-c' ${CRUISE_ID} ${LOWERING_ID}
done

echo "Done!"
echo ""