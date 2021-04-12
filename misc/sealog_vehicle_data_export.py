#!/usr/bin/env python3
#
#  Purpose: This script exports all the data for a given lowering, creates all the reports for that lowering,
#           and pushes the data to the OpenVDM data directory for that lowering. 
#
#    Usage: Type python3 merge_ctd.py <lowering_id> <raw_ctd_file> to run the script.
#            - <lowering_id>: the lowering ID (J2-1042)
#            - <raw_ctd_file>: the raw_ctd_file name with absolute/relative path (./UDP-SB-CTD-RAW_20200128-234312.Raw)
#
#   Author: Webb Pinner webbpinner@gmail.com
#  Created: 2018-11-07
# Modified: 2020-10-17
# from python_sealog.settings import apiServerURL, apiServerFilePath, cruisesAPIPath, eventsAPIPath, customVarAPIPath, headers
import logging
import tempfile
import subprocess
import requests
import glob
import json
import os
from datetime import datetime

from python_sealog.settings import apiServerFilePath
from python_sealog.cruises import getCruises, getCruiseByID, getCruiseByLowering
from python_sealog.lowerings import getLowerings, getLoweringByID, getLoweringsByCruise
from python_sealog.misc import getFramegrabListByLowering
from python_sealog.events import getEvent, getEventsByLowering
from python_sealog.event_aux_data import getEventAuxDataByLowering
from python_sealog.event_exports import getEventExport, getEventExportsByLowering
from python_sealog.event_templates import getEventTemplates
from filecroputility import FileCropUtility

from sealog_build_cruise_summary_report_OXR_Argus import CruiseSummaryReport
from sealog_build_lowering_summary_report_OXR_Argus import LoweringSummaryReport
from sealog_build_lowering_vehicle_report_OXR_Argus import LoweringVehicleReport

BACKUP_ROOT_DIR = '/home/oceanx/sealog-backups-argus'
VEHICLE_NAME = 'Chimaera'

RAW_DATA_DIR = '/mnt/nfs/CruiseData/'
CROPPED_DATA_DIR = '/home/oceanx/cropped_data-argus'
OPENRVDAS_SOURCE_DIR = 'Vessel/OpenRVDAS/raw'
OPENRVDAS_DEST_DIR = 'OpenRVDAS/raw'

POST_CRUISE_REPORT_DIR = 'Documents/PostCruise_Reports'

DATA_FILES_DEFS = [
  { 'source_regex': 'HiPAP_Argus_PSIMSSB*', 'output_prefix': 'HiPAP_Argus_PSIMSSB_'},
  { 'source_regex': 'Qinsy_Argus_GGA*', 'output_prefix': 'Qinsy_Argus_GGA_'},
  { 'source_regex': 'VideoLogger_Argus_GGA*', 'output_prefix': 'VideoLogger_Argus_GGA_'},
  { 'source_regex': 'VideoLogger_Argus_NAV*', 'output_prefix': 'VideoLogger_Argus_NAV_'}
]

OPENVDM_IP='openvdm.oceanxplorer.org'
OPENVDM_USER='oceanx'
OPENVDM_SSH_KEY='/home/oceanx/.ssh/id_rsa_openvdm'
CRUISEDATA_DIR_ON_DATA_WAREHOUSE='/mnt/vault/FTPRoot/CruiseData'
OPENVDM_VEHICLE_DIR='Vehicles/' + VEHICLE_NAME
SEALOG_DIR='Sealog'

CREATE_DEST_DIR = False

CRUISES_FILE_PATH = os.path.join(apiServerFilePath, 'cruises')
IMAGES_FILE_PATH = os.path.join(apiServerFilePath, 'images')
LOWERINGS_FILE_PATH = os.path.join(apiServerFilePath, 'lowerings')

REPORTS_DIRNAME = 'Reports'
IMAGES_DIRNAME = 'Images'
FILES_DIRNAME = 'Files'

# default log level
LOG_LEVEL = logging.INFO

# create logger
logging.basicConfig(level=LOG_LEVEL,
                    format='%(levelname)s - %(message)s'
                   )

logger = logging.getLogger(__file__)

def _exportDirName(cruise_id, lowering_id):
  if lowering_id[1:].isnumeric():
    return cruise_id + '_' + lowering_id

  return lowering_id


def _verifySourceDirectories():

  if not os.path.isdir(CRUISES_FILE_PATH):
    return False, "cannot find cruises file path"

  if not os.path.isdir(IMAGES_FILE_PATH):
    return False, "cannot find images file path"

  if not os.path.isdir(LOWERINGS_FILE_PATH):
    return False, "cannot find lowerings file path"

  return True, ''


def _buildCruiseBackupDirs(cruise):

  logger.info("Building cruise-level backup directories")

  try:
    os.mkdir(os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id']))
  except FileExistsError:
    logger.debug("cruise backup directory already exists")
  except Exception as error:
    logger.error("Could not create cruise backup directory")
    sys.exit(1)

  try:
    os.mkdir(os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], REPORTS_DIRNAME))
  except FileExistsError:
    logger.debug("cruise backup reports directory already exists")
  except Exception as error:
    logger.error("Could not create cruise reports backup directory")
    sys.exit(1)

  try:
    os.mkdir(os.path.join(CROPPED_DATA_DIR, cruise['cruise_id']))
  except FileExistsError:
    logger.debug("cruise cropped data backup directory already exists")
  except Exception as error:
    logger.error("Could not create cruise cropped data backup directory")
    sys.exit(1)


def _buildLoweringBackupDirs(cruise, lowering):

  logger.info("Building lowering-level backup directories")

  try:
    os.mkdir(os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id'])))
  except FileExistsError:
    logger.debug("lowering backup directory already exists")
  except Exception as error:
    logger.error("Could not create lowering backup directory")
    sys.exit(1)

  try:
    os.mkdir(os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), REPORTS_DIRNAME))
  except FileExistsError:
    logger.debug("lowering backup reports directory already exists")
  except Exception as error:
    logger.error("Could not create lowering reports backup directory")
    sys.exit(1)

  try:
    os.mkdir(os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), IMAGES_DIRNAME))
  except FileExistsError:
    logger.debug("lowering backup images directory already exists")
  except Exception as error:
    logger.error("Could not create lowering images backup directory")
    sys.exit(1)

  try:
    os.makedirs(os.path.join(CROPPED_DATA_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), OPENRVDAS_DEST_DIR))
  except FileExistsError:
    logger.debug("lowering backup directory already exists")
  except Exception as error:
    logger.error("Could not create lowering backup directory")
    sys.exit(1)


def _buildLoweringMarker(lowering):

  try:
    on_bottom_event = list(filter(lambda event: event['ts'] == lowering['lowering_additional_meta']['milestones']['lowering_on_bottom'], getEventsByLowering(lowering['id'])))[0]
    # logger.debug(on_bottom_event)
  except Exception as e:
    logger.warning('Could not find on_bottom milestone {}'.format(str(e)))
    return None

  try:
    on_bottom_event_export = getEventExport(on_bottom_event['id'])
    # logger.debug(on_bottom_event_export)
    vehicleRealtimeNavData = list(filter(lambda aux_data: aux_data['data_source'] == 'vehicleRealtimeNavData', on_bottom_event_export['aux_data']))[0]
    # logger.debug(vehicleRealtimeNavData)
    lat = list(filter(lambda data_item: data_item['data_name'] == 'latitude', vehicleRealtimeNavData['data_array']))[0]['data_value']
    lon = list(filter(lambda data_item: data_item['data_name'] == 'longitude', vehicleRealtimeNavData['data_array']))[0]['data_value']
    depth = list(filter(lambda data_item: data_item['data_name'] == 'depth', vehicleRealtimeNavData['data_array']))[0]['data_value']

    # DiveID,lat,Lon,depth.txt
    return lowering['lowering_id'] + ',' + str(lat) + ',' + str(lon) + ',' + str(depth * -1)

  except Exception as e:
    logger.warning('Could not extract nav data from on_bottom event {}'.format(str(e)))
    return None

def _exportLoweringMarkersFile(cruise):

  logger.info("Exporting lowering markers file")

  lowerings = getLoweringsByCruise(cruise['id'])

  lowering_markers = []
  
  for lowering in lowerings:
  
    lowering_marker = _buildLoweringMarker(lowering)
    # logger.debug(lowering_marker)

    if lowering_marker:
      lowering_markers.append(lowering_marker)

  filename = VEHICLE_NAME + '_' + cruise['cruise_id'] + '_loweringMarkers.txt'
  dest_filepath = os.path.join(apiServerFilePath, 'cruises', cruise['id'], filename)
  
  try:
    with open(dest_filepath, 'w') as file:
      for marker in lowering_markers:
        # logger.debug(marker)
        file.write(marker + '\r\n')
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)


def _exportLoweringSealogDataFiles(cruise, lowering):

  logger.info("Exporting lowering-level data files")

  filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_loweringRecord.json'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), filename)
  
  logger.info("Export Lowering Record: " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(json.dumps(lowering))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)

  filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_eventOnlyExport.json'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), filename)

  logger.info("Export Events (json-format): " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(json.dumps(getEventsByLowering(lowering['id'])))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)


  filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_eventOnlyExport.csv'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), filename)
  
  logger.info("Export Events (csv-format): " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(getEventsByLowering(lowering['id'], 'csv'))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)


  filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_auxDataExport.json'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), filename)
  
  logger.info("Export Aux Data: " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(json.dumps(getEventAuxDataByLowering(lowering['id'])))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)


  filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_sealogExport.json'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), filename)
  
  logger.info("Export Events with Aux Data (json-format): " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(json.dumps(getEventExportsByLowering(lowering['id'])))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)


  filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_sealogExport.csv'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), filename)
  
  logger.info("Export Events with Aux Data (csv-format): " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(getEventExportsByLowering(lowering['id'], 'csv'))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)

  filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_eventTemplates.json'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), filename)
  
  logger.info("Export Event Templates: " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(json.dumps(getEventTemplates()))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)

  logger.info("Export Images")
  framegrabList = getFramegrabListByLowering(lowering['id'])
  rsync_filelist = tempfile.NamedTemporaryFile(mode='w+b', delete=False)
  for framegrab in framegrabList:

    framegrab = os.path.basename(framegrab)
    rsync_filelist.write(str.encode(framegrab + '\n'))

  output = subprocess.call(['rsync','-avi','--progress', '--delete', '--files-from=' + rsync_filelist.name , os.path.join(apiServerFilePath, 'images', ''), os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), IMAGES_DIRNAME)])
  # logger.debug(output)

  rsync_filelist.close()

  logger.info("Export Reports")
  output = subprocess.call(['rsync','-avi','--progress', '--delete', '--include=*.pdf', '--exclude=*', os.path.join(apiServerFilePath, 'lowerings', lowering['id'], ''), os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), REPORTS_DIRNAME)])
  # logger.debug(output)

  # logger.info("Export Files")
  # output = subprocess.call(['rsync','-avi','--progress', '--delete', '--include=*.json', '--include=*.kml', '--exclude=*', os.path.join(apiServerFilePath, 'lowerings', lowering['id'], ''), os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), FILES_DIRNAME)])
  # logger.debug(output)


def _exportLoweringOpenRVDASDataFiles(cruise, lowering):

  logger.info("Exporting lowering-level OpenRVDAS data files")

  fcu = FileCropUtility(datetime.strptime(lowering['start_ts'], '%Y-%m-%dT%H:%M:%S.%fZ'), datetime.strptime(lowering['stop_ts'], '%Y-%m-%dT%H:%M:%S.%fZ'))
  # fcu.getLogger().setLevel(log_level)

  for data_file_def in DATA_FILES_DEFS:

    source_regex = os.path.join(RAW_DATA_DIR,cruise['cruise_id'], OPENRVDAS_SOURCE_DIR, data_file_def['source_regex'])
    source_files = glob.glob(os.path.join(RAW_DATA_DIR,cruise['cruise_id'], OPENRVDAS_SOURCE_DIR, data_file_def['source_regex']))
    destination_file = os.path.join(CROPPED_DATA_DIR,cruise['cruise_id'],lowering['lowering_id'],OPENRVDAS_DEST_DIR,data_file_def['output_prefix'] + lowering['lowering_id'] + '.txt')

    logger.debug('Source regex: {}'.format(source_regex))
    logger.debug('Source files: {}'.format(source_files))
    logger.debug('Destination file: {}'.format(destination_file))

    try:      
      culled_files = fcu.cull_files(source_files)
      
      if len(culled_files) > 0:
        with open(destination_file, 'w') as f:
          for line in fcu.crop_file_data(culled_files):
            f.write(line)
      else:
        logging.warning("No files containing data in the specified range")

    except:
      logger.warning("Could not create cropped data file: {}".format(destination_file))


def _exportCruiseDataFiles(cruise):

  logger.info("Exporting cruise-level data files")

  filename = VEHICLE_NAME + '_' + cruise['cruise_id'] + '_cruiseRecord.json'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], filename)
  
  logger.info("Export Cruise Record: " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(json.dumps(cruise))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)

  filename = VEHICLE_NAME + '_' + cruise['cruise_id'] + '_eventTemplates.json'
  dest_filepath = os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], filename)

  logger.info("Export Event Templates: " + filename)
  try:
    with open(dest_filepath, 'w') as file:
      file.write(json.dumps(getEventTemplates()))
  except Exception as error:
    logger.error('could not create data file: ', dest_filepath)

  logger.info("Export Reports")
  output = subprocess.call(['rsync','-avi','--progress', '--delete', '--include=*.pdf', '--exclude=*', os.path.join(apiServerFilePath, 'cruises', cruise['id'], ''), os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], REPORTS_DIRNAME)])
  # logger.debug(output)


def _buildCruiseReports(cruise):

  logger.info("Building cruise reports")

  report_dest_dir = os.path.join(apiServerFilePath, 'cruises', cruise['id'])

  report_filename =  VEHICLE_NAME + '_' + cruise['cruise_id'] + '_Cruise_Summary_Report.pdf'
  logger.info("Building Cruise Summary Report: " + report_filename)
  PDF = CruiseSummaryReport(cruise['id'], VEHICLE_NAME)

  try:
      f = open(os.path.join(report_dest_dir, report_filename), 'wb')
      f.write(PDF.build_pdf())
      f.close()
 
  except Exception as error:
      logger.error("Unable to build report")
      logger.error(str(error))


def _buildLoweringReports(cruise, lowering):

  logger.info("Building lowering reports")

  report_dest_dir = os.path.join(apiServerFilePath, 'lowerings', lowering['id'])

  summary_report_filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_Dive_Summary_Report.pdf'
  logger.info("Building Lowering Summary Report: " + summary_report_filename)
  PDF = LoweringSummaryReport(lowering['id'], VEHICLE_NAME)

  try:
    f = open(os.path.join(report_dest_dir, summary_report_filename), 'wb')
    f.write(PDF.build_pdf())
    f.close()
 
  except Exception as error:
    logger.error("Unable to build report")
    logger.error(str(error))

  vehicle_report_filename = VEHICLE_NAME + '_' + lowering['lowering_id'] + '_Dive_Vehicle_Report.pdf'
  logger.info("Building Lowering Vehicle Report: " + vehicle_report_filename)
  PDF = LoweringVehicleReport(lowering['id'], VEHICLE_NAME)

  try:
    f = open(os.path.join(report_dest_dir, vehicle_report_filename), 'wb')
    f.write(PDF.build_pdf())
    f.close()
 
  except Exception as error:
    logger.error("Unable to build report")
    logger.error(str(error))


def _pushToDataWarehouse(cruise, lowering):

  if CREATE_DEST_DIR:
    command = ['ssh', '-i', OPENVDM_SSH_KEY, OPENVDM_USER + '@' + OPENVDM_IP, 'cd ' + os.path.join(CRUISEDATA_DIR_ON_DATA_WAREHOUSE,cruise['cruise_id'],OPENVDM_VEHICLE_DIR) + '; test -d ' + os.path.join(_exportDirName(cruise['cruise_id'], lowering['lowering_id']),SEALOG_DIR) + ' || mkdir -p ' + os.path.join(_exportDirName(cruise['cruise_id'], lowering['lowering_id']),SEALOG_DIR) + '']
    logger.debug(' '.join(command))
    subprocess.call(command)

    command = ['ssh', '-i', OPENVDM_SSH_KEY, OPENVDM_USER + '@' + OPENVDM_IP, 'cd ' + os.path.join(CRUISEDATA_DIR_ON_DATA_WAREHOUSE,cruise['cruise_id'],OPENVDM_VEHICLE_DIR) + '; test -d ' + os.path.join(_exportDirName(cruise['cruise_id'], lowering['lowering_id']),OPENRVDAS_DEST_DIR) + ' || mkdir -p ' + os.path.join(_exportDirName(cruise['cruise_id'], lowering['lowering_id']),OPENRVDAS_DEST_DIR) + '']
    logger.debug(' '.join(command))
    subprocess.call(command)

  command = ['rsync','-trimv','--progress', '-e', 'ssh -i ' + OPENVDM_SSH_KEY, os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], REPORTS_DIRNAME, ''), OPENVDM_USER + '@' + OPENVDM_IP + ':' + os.path.join(CRUISEDATA_DIR_ON_DATA_WAREHOUSE,cruise['cruise_id'], POST_CRUISE_REPORT_DIR, '')]
  logger.debug(' '.join(command))
  output = subprocess.call(command)

  command = ['rsync','-trimv','--progress', '--delete', '-e', 'ssh -i ' + OPENVDM_SSH_KEY, os.path.join(BACKUP_ROOT_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), ''), OPENVDM_USER + '@' + OPENVDM_IP + ':' + os.path.join(CRUISEDATA_DIR_ON_DATA_WAREHOUSE,cruise['cruise_id'],OPENVDM_VEHICLE_DIR,_exportDirName(cruise['cruise_id'], lowering['lowering_id']),SEALOG_DIR, '')]
  logger.debug(' '.join(command))
  output = subprocess.call(command)

  command = ['rsync','-trimv','--progress', '--delete', '-e', 'ssh -i ' + OPENVDM_SSH_KEY, os.path.join(CROPPED_DATA_DIR, cruise['cruise_id'], _exportDirName(cruise['cruise_id'], lowering['lowering_id']), OPENRVDAS_DEST_DIR, ''), OPENVDM_USER + '@' + OPENVDM_IP + ':' + os.path.join(CRUISEDATA_DIR_ON_DATA_WAREHOUSE,cruise['cruise_id'],OPENVDM_VEHICLE_DIR,_exportDirName(cruise['cruise_id'], lowering['lowering_id']),OPENRVDAS_DEST_DIR, '')]
  logger.debug(' '.join(command))
  output = subprocess.call(command)

if __name__ == '__main__':

  import argparse
  import sys

  parser = argparse.ArgumentParser(description='Sealog ' + VEHICLE_NAME + ' Data export')
  parser.add_argument('-d', '--debug', action='store_true', help=' display debug messages')
  parser.add_argument('-n', '--no-transfer', action='store_true', default=False, help='build reports and export data but do not push to data warehouse')
  parser.add_argument('-c', '--current_cruise', action='store_true', default=False, help=' export the data for the most recent cruise')
  parser.add_argument('-L', '--lowering_id', help='export data for the specified lowering (i.e. S0314)')
  parser.add_argument('-C', '--cruise_id', help='export all cruise and lowering data for the specified cruise (i.e. FK200126)')

  
  args = parser.parse_args()

  # Turn on debug mode
  if args.debug:
    logger.info("Setting log level to DEBUG")
    logger.setLevel(logging.DEBUG)

    for handler in logger.handlers:
      handler.setLevel(logging.DEBUG)

    logger.debug("Log level now set to DEBUG")

  if args.current_cruise:
    if args.lowering_id or args.cruise_id:
      logger.error("Can not specify current_cruise and also a lowering \(-l\) or cruise \(-c\)")
      sys.exit(0)

  elif args.lowering_id and args.cruise_id:
    logger.error("Can not specify a lowering \(-l\) and cruise \(-c\)")
    sys.exit(0)


  # Verify source directories
  success, msg = _verifySourceDirectories()
  if not success:
    logger.error(msg)
    sys.exit(0)

  # Verify backup root directory
  if not os.path.isdir(BACKUP_ROOT_DIR):
    logger.error("cannot find backup directory: " + BACKUP_ROOT_DIR)
    sys.exit(1)


  # Current Cruise Specified
  # ========================
  if args.current_cruise:

    # retrieve current cruise record
    current_cruise = next(iter(getCruises()), None)
    if not current_cruise:
      logger.error("Cruise not found.")
      sys.exit(1)

    logger.info("Cruise ID: " + current_cruise['cruise_id'])
    if 'cruise_name' in current_cruise['cruise_additional_meta']:
      logger.info("Cruise Name: " + current_cruise['cruise_additional_meta']['cruise_name'])

    # current_cruise source dir
    cruise_source_dir = os.path.join(CRUISES_FILE_PATH, current_cruise['id'])

    #verify current_cruise source directory exists
    try:
      os.path.isdir(cruise_source_dir)
    except:
      logger.error('cannot find source directory for cruise: ' + cruise_source_dir);
      sys.exit(1)

    # build cruise report
    _buildCruiseReports(current_cruise)

    # build cruise backup dir
    _buildCruiseBackupDirs(current_cruise)

    # export cruise data files
    _exportCruiseDataFiles(current_cruise)

    # export lowering markers file
    _exportLoweringMarkersFile(current_cruise)

    # retieve lowering records for current cruise
    current_lowerings = getLoweringsByCruise(current_cruise['id'])

    if len(current_lowerings) == 0:
      logger.warning("No lowerings found for current cruise")

    else:
      # for each lowering in cruise

      for lowering in current_lowerings:
        logger.info("Lowering: " + lowering['lowering_id'])

        # lowering source dir
        lowering_source_dir = os.path.join(LOWERINGS_FILE_PATH, lowering['id'])

        #verify current_cruise source directory exists
        if not os.path.isdir(lowering_source_dir):
          logger.error('cannot find source directory for lowering: ' + lowering_source_dir);
          sys.exit(1)

        # build lowering reports
        _buildLoweringReports(current_cruise, lowering)

        # build lowering backup dir
        _buildLoweringBackupDirs(current_cruise, lowering)
        
        # export lowering data files
        _exportLoweringSealogDataFiles(current_cruise, lowering)

        # export lowering cropped data files
        _exportLoweringOpenRVDASDataFiles(current_cruise, lowering)

        # sync data to data warehouse
        if not args.no_transfer:
          _pushToDataWarehouse(current_cruise, lowering)

  # Specified Cruise ID
  # ========================    
  elif args.cruise_id:

    # retrieve specified cruise record
    current_cruise = getCruiseByID(args.cruise_id)
    if not current_cruise:
      logger.error("Cruise not found.")
      sys.exit(1)

    logger.info("Cruise ID: " + current_cruise['cruise_id'])
    if 'cruise_name' in current_cruise['cruise_additional_meta']:
      logger.info("Cruise Name: " + current_cruise['cruise_additional_meta']['cruise_name'])

    # current_cruise source dir
    cruise_source_dir = os.path.join(CRUISES_FILE_PATH, current_cruise['id'])

    #verify current_cruise source directory exists
    try:
      os.path.isdir(cruise_source_dir)
    except:
      logger.error('cannot find source directory for cruise: ' + cruise_source_dir);
      sys.exit(1)

    # build cruise report
    _buildCruiseReports(current_cruise)

    # build cruise backup dir
    _buildCruiseBackupDirs(current_cruise)

    # export cruise data files
    _exportCruiseDataFiles(current_cruise)

    # export lowering markers file
    _exportLoweringMarkersFile(current_cruise)

    # retieve lowering records for current cruise
    current_lowerings = getLoweringsByCruise(current_cruise['id'])

    if len(current_lowerings) == 0:
      logger.warning("No lowerings found for current cruise")

    else:

      # for each lowering in cruise
      for lowering in current_lowerings:
        logger.info("Lowering: " + lowering['lowering_id'])

        # lowering source dir
        lowering_source_dir = os.path.join(LOWERINGS_FILE_PATH, lowering['id'])

        #verify current_cruise source directory exists
        if not os.path.isdir(lowering_source_dir):
          logger.error('cannot find source directory for lowering: ' + lowering_source_dir);
          sys.exit(1)

        # build lowering reports
        _buildLoweringReports(current_cruise, lowering)

        # build lowering backup dir
        _buildLoweringBackupDirs(current_cruise, lowering)
        
        # export lowering data files
        _exportLoweringSealogDataFiles(current_cruise, lowering)

        # export lowering cropped data files
        _exportLoweringOpenRVDASDataFiles(current_cruise, lowering)

        # sync data to data warehouse
        if not args.no_transfer:
          _pushToDataWarehouse(current_cruise, lowering)

  # Specified Lowering ID
  # ========================    
  elif args.lowering_id:

    # retieve specified lowering record
    current_lowering = getLoweringByID(args.lowering_id)

    if not current_lowering:
      logger.error("Lowering not found.")
      sys.exit(1)

    logger.debug("Lowering ID: " + current_lowering['lowering_id'])

    # current_lowering source dir
    lowering_source_dir = os.path.join(LOWERINGS_FILE_PATH, current_lowering['id'])

    #verify current_lowering source directory exists
    if not os.path.isdir(lowering_source_dir):
      logger.error('cannot find source directory for lowering: ' + lowering_source_dir);
      sys.exit(1)

    # retrieve corresponding cruise record
    current_cruise = getCruiseByLowering(current_lowering['id'])

    if not current_cruise:
      logger.error("Lowering is not part of a cruise")
      sys.exit(1)

    logger.info("Cruise ID: " + current_cruise['cruise_id'])

    if 'cruise_name' in current_cruise['cruise_additional_meta']:
      logger.info("Cruise Name: " + current_cruise['cruise_additional_meta']['cruise_name'])

    # current_cruise source dir
    cruise_source_dir = os.path.join(CRUISES_FILE_PATH, current_cruise['id'])

    #verify current_cruise source directory exists
    try:
      os.path.isdir(cruise_source_dir)
    except:
      logger.error('cannot find source directory for cruise: ' + cruise_source_dir);
      sys.exit(1)

    # build cruise report
    _buildCruiseReports(current_cruise)

    # build cruise backup dir
    _buildCruiseBackupDirs(current_cruise)

    # export cruise data files
    _exportCruiseDataFiles(current_cruise)

    # export lowering markers file
    _exportLoweringMarkersFile(current_cruise)

    logger.info("Lowering: " + current_lowering['lowering_id'])

    # lowering source dir
    lowering_source_dir = os.path.join(LOWERINGS_FILE_PATH, current_lowering['id'])

    #verify current_cruise source directory exists
    if not os.path.isdir(lowering_source_dir):
      logger.error('cannot find source directory for lowering: ' + lowering_source_dir);
      sys.exit(1)

    # build lowering reports
    _buildLoweringReports(current_cruise, current_lowering)

    # build lowering backup dir
    _buildLoweringBackupDirs(current_cruise, current_lowering)
    
    # export lowering data files
    _exportLoweringSealogDataFiles(current_cruise, current_lowering)

    # export lowering cropped data files
    _exportLoweringOpenRVDASDataFiles(current_cruise, current_lowering)

    # sync data to data warehouse
    if not args.no_transfer:
      _pushToDataWarehouse(current_cruise, current_lowering)

  else:

    current_lowering = next(iter(getLowerings()), None)

    if not current_lowering:
      logger.error("Lowering not found.")
      sys.exit(1)

    logger.debug("Lowering ID: " + current_lowering['lowering_id'])

    # current_lowering source dir
    lowering_source_dir = os.path.join(LOWERINGS_FILE_PATH, current_lowering['id'])

    #verify current_lowering source directory exists
    if not os.path.isdir(lowering_source_dir):
      logger.error('cannot find source directory for lowering: ' + lowering_source_dir);
      sys.exit(1)

    # retrieve corresponding cruise record
    current_cruise = getCruiseByLowering(current_lowering['id'])

    if not current_cruise:
      logger.error("Lowering is not part of a cruise")
      sys.exit(1)

        # build cruise report
    _buildCruiseReports(current_cruise)

    # build cruise backup dir
    _buildCruiseBackupDirs(current_cruise)

    # export cruise data files
    _exportCruiseDataFiles(current_cruise)

    # export lowering markers file
    _exportLoweringMarkersFile(current_cruise)

    logger.info("Lowering: " + current_lowering['lowering_id'])

    # lowering source dir
    lowering_source_dir = os.path.join(LOWERINGS_FILE_PATH, current_lowering['id'])

    #verify current_cruise source directory exists
    if not os.path.isdir(lowering_source_dir):
      logger.error('cannot find source directory for lowering: ' + lowering_source_dir);
      sys.exit(1)

    # build lowering reports
    _buildLoweringReports(current_cruise, current_lowering)

    # build lowering backup dir
    _buildLoweringBackupDirs(current_cruise, current_lowering)
    
    # export lowering data files
    _exportLoweringSealogDataFiles(current_cruise, current_lowering)

    # export lowering cropped data files
    _exportLoweringOpenRVDASDataFiles(current_cruise, current_lowering)

    # sync data to data warehouse
    if not args.no_transfer:
      _pushToDataWarehouse(current_cruise, current_lowering)

  logger.debug("Done")
