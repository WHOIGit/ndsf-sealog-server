#!/usr/bin/env python3
'''
FILE:           sealog_lowering_nav_2_csv.py

DESCRIPTION:    This script exports the navigation data for the specified
                lowering to csv format

BUGS:
NOTES:
AUTHOR:     Webb Pinner
COMPANY:    OceanDataTools.org
VERSION:    1.0
CREATED:    2021-04-21
REVISION:   2022-02-13

LICENSE INFO:   This code is licensed under MIT license (see LICENSE.txt for details)
                Copyright (C) OceanDataTools.org 2024
'''

import sys
import json
import logging
from io import StringIO
from datetime import datetime
import pandas as pd
from fastkml import kml
from shapely.geometry import LineString, Point
import geojson

from os.path import dirname, realpath
sys.path.append(dirname(dirname(realpath(__file__))))

from misc.python_sealog.lowerings import get_lowerings, get_lowering_by_id
from misc.python_sealog.event_exports import get_event_exports_by_lowering

DESIRED_RAW_COLS = ['ts','realtimeVehicleUSBLPosition.longitude_value','realtimeVehicleUSBLPosition.latitude_value', 'realtimeVehicleUSBLPosition.depth_value']
ALT_DESIRED_RAW_COLS = ['ts','realtimeVehiclePosition.longitude_value','realtimeVehiclePosition.latitude_value', 'realtimeVehiclePosition.depth_value']
DESIRED_PROC_COLS = ['datetime','longitude_ddeg','latitude_ddeg', 'depth_m']

ROUNDING = {
    'longitude_ddeg': 8,
    'latitude_ddeg': 8,
    'depth_m': 2
}

class ExportLoweringNav2CSV():
    '''
    Class that exports lowering navigation data and converts it to csv format
    '''

    def __init__(self, lowering_id=None, raw_columns=None, proc_columns=None, precision=None):
        self.lowering_id = lowering_id
        self.raw_columns = raw_columns or DESIRED_RAW_COLS
        self.proc_columns = proc_columns or DESIRED_PROC_COLS
        self.precision = precision or ROUNDING
        self.data = None
        self.logger = logging.getLogger('ExportLoweringNav2CSV')

        self.export_lowering()

    def round_data(self):
        '''
        Round the data to the specified precision
        '''

        try:
            decimals = pd.Series(self.precision.values(), index=self.precision.keys())
            self.data = self.data.round(decimals)
        except Exception as err:
            logging.error("Could not round data")
            logging.error(str(err))
            raise err


    def export_lowering(self):
        '''
        Retrieve the lowering record, retrieve the lowering event_export data
        for the lowering, extract the navigation data from the event_export
        data.
        '''

        # retrieve specified lowering record
        logging.info("Retrieving lowering record")
        lowering = None
        if self.lowering_id is not None:
            lowering = get_lowering_by_id(self.lowering_id)
        else:
            lowering = get_lowerings()[0]

        if not lowering:
            logging.error("Lowering %s not found.", self.lowering_id)
            return None

        logging.debug("Lowering:\n%s", json.dumps(lowering, indent=2))

        logging.info("Extracting \"lowering_descending\" and \"lowering_on_surface\" timestamps")
        try:
            start_ts = datetime.strptime(lowering['lowering_additional_meta']['milestones']['lowering_descending'], '%Y-%m-%dT%H:%M:%S.%fZ')
            end_ts = datetime.strptime(lowering['lowering_additional_meta']['milestones']['lowering_on_surface'], '%Y-%m-%dT%H:%M:%S.%fZ')
        except Exception as err:
            logging.error("Problem extracting \"lowering_descending\" and \"lowering_on_surface\" timestamps")
            logging.debug(str(err))
            return None

        # get the events for the lowering
        logging.info("Exporting events for lowering")
        events = get_event_exports_by_lowering(lowering['id'], export_format='csv')

        if events is None:
            logging.error("No events found for lowering %s:", self.lowering_id)
            return None

        file = StringIO(events)

        # import events into pandas dataframe
        logging.info("Importing events into dataframe for processing.")
        try:
            self.data = pd.read_csv(file, usecols=self.raw_columns)
            self.data['ts'] = pd.to_datetime(self.data['ts'], format='%Y-%m-%dT%H:%M:%S.%fZ')

        except Exception as err:
            logging.error("Error importing events data into dataframe")
            logging.error(str(err))
            return None

        logging.debug("Data:\n%s", self.data.head())

        # crop the events
        logging.info("Cropping lowering events to \"lowering_descending\" and \"lowering_on_surface\" timestamps")
        self.data = self.data[(self.data['ts'] >= start_ts)]
        self.data = self.data[(self.data['ts'] <= end_ts)]

        # resample at 1min
        logging.info('Subsampling data to 1-minute')
        self.data.set_index('ts',inplace=True)
        self.data = self.data.resample('6s', label='left', closed='left').first()
        self.data.reset_index(inplace=True)

        # cleanup
        logging.debug("removing NaNs")
        self.data = self.data.dropna()

        # rename columns
        self.data = self.data[self.raw_columns]
        self.data.columns = self.proc_columns

        # round data
        logging.info("Rounding data: %s", self.precision)
        self.round_data()

        return None


    def __str__(self):
        '''
        Return the navigation data in csv format
        '''

        return self.data.to_csv(index=False, na_rep='', date_format='%Y-%m-%dT%H:%M:%SZ')

    def to_kml(self, file=None):
        # Load the CSV file into a DataFrame
        #df = pd.read_csv(csv_file)
    
        # Initialize the KML document
        k = kml.KML()
        document = kml.Document()
        k.append(document)
    
        # Create a LineString from the points
        coordinates = [(row['longitude_ddeg'], row['latitude_ddeg']) for _, row in self.data.iterrows()]
        line = LineString(coordinates)
    
        # Create a Placemark for the route
        route_placemark = kml.Placemark()
        route_placemark.name = "Route"
        route_placemark.geometry = line
    
        # Add Placemark to Document
        document.append(route_placemark)
    
        if file is None:
            print(k.to_string(prettyprint=True))
            return

        # Write KML to file
        with open(file, 'w') as f:
           f.write(k.to_string(prettyprint=True))

    def to_geojson(self, file=None):
        # Load the CSV file into a DataFrame
        #df = pd.read_csv(csv_file)

        # Create a list of coordinates from the DataFrame
        coordinates = [(row['longitude_ddeg'], row['latitude_ddeg'], row['depth_m'] * -1) for _, row in self.data.iterrows()]

        # Create a LineString geometry for the route
        route = geojson.LineString(coordinates)

        # Create a Feature for the route
        route_feature = geojson.Feature(geometry=route, properties={"name": "Route"})

        # Create a FeatureCollection
        feature_collection = geojson.FeatureCollection([route_feature])

        if file is None:
            print(geojson.dumps(feature_collection))
            return

        # Write GeoJSON to file
        with open(file, 'w') as f:
            geojson.dump(feature_collection, f)


# -------------------------------------------------------------------------------------
# Main function
# -------------------------------------------------------------------------------------
if __name__ == "__main__":

    import os
    import argparse

    parser = argparse.ArgumentParser(description='Export lowering navigation data to csv')
    parser.add_argument('-v', '--verbosity', dest='verbosity', default=0, action='count', help='Increase output verbosity, default level: warning')
    parser.add_argument('-k', '--kml', action='store_true', help='output as KML')
    parser.add_argument('-g', '--geojson', action='store_true', help='output as geoJSON')
    parser.add_argument('-o', '--outfile', type=str, metavar='outfile', help='Write output to specified outfile')
    parser.add_argument('-l','--lowering_id', type=str, help='The lowering_id to export')

    parsed_args = parser.parse_args()

    ############################
    # Set up logging before we do any other argument parsing (so that we
    # can log problems with argument parsing).

    LOGGING_FORMAT = '%(asctime)-15s %(levelname)s - %(message)s'
    logging.basicConfig(format=LOGGING_FORMAT)

    LOG_LEVELS = {0: logging.WARNING, 1: logging.INFO, 2: logging.DEBUG}
    parsed_args.verbosity = min(parsed_args.verbosity, max(LOG_LEVELS))
    logging.getLogger().setLevel(LOG_LEVELS[parsed_args.verbosity])

    try:

        try:
            lowering_export = ExportLoweringNav2CSV(parsed_args.lowering_id)

        except:
            logging.warning("There was a problem with the preference nav reference, trying again with alternative nav reference.")
            lowering_export = ExportLoweringNav2CSV(parsed_args.lowering_id, raw_columns=ALT_DESIRED_RAW_COLS)

        if parsed_args.kml:
            lowering_export.to_kml(parsed_args.outfile)

        elif parsed_args.geojson:
            lowering_export.to_geojson(parsed_args.outfile)

        elif parsed_args.outfile is not None:
            with open(parsed_args.outfile, 'w') as out_file:
                out_file.write(str(lowering_export))

        else:
            print(lowering_export)


    except KeyboardInterrupt:
        logging.warning('Interrupted')
        try:
            sys.exit(0)
        except SystemExit:
            os._exit(0) # pylint: disable=protected-access
