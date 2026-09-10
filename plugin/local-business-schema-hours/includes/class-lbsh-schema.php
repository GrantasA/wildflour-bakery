<?php
/**
 * Builds schema.org LocalBusiness JSON-LD. No WordPress dependencies.
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

/**
 * Turns a stored location plus its schedule into a JSON-LD graph node.
 */
class LBSH_Schema {

	/**
	 * schema.org types offered in the admin UI.
	 *
	 * Every entry is a documented subtype of LocalBusiness, so Google treats
	 * them all as valid local business markup.
	 *
	 * @return array Type slug => human readable label.
	 */
	public static function types() {
		return array(
			'LocalBusiness'      => 'Local business (generic)',
			'Bakery'             => 'Bakery',
			'CafeOrCoffeeShop'   => 'Cafe or coffee shop',
			'Restaurant'         => 'Restaurant',
			'BarOrPub'           => 'Bar or pub',
			'FoodEstablishment'  => 'Food establishment (other)',
			'Store'              => 'Store',
			'HealthAndBeautyBusiness' => 'Health and beauty',
			'ProfessionalService'     => 'Professional service',
			'AutomotiveBusiness'      => 'Automotive',
			'HomeAndConstructionBusiness' => 'Home and construction',
			'MedicalBusiness'    => 'Medical',
			'LodgingBusiness'    => 'Lodging',
			'SportsActivityLocation'  => 'Gym or sports venue',
		);
	}

	/**
	 * Build the JSON-LD node for a location.
	 *
	 * Empty values are omitted rather than emitted blank, because Google
	 * reports empty properties as structured data errors.
	 *
	 * @param array         $business Location fields.
	 * @param LBSH_Schedule $schedule Opening hours for the location.
	 * @return array
	 */
	public static function build( array $business, LBSH_Schedule $schedule ) {
		$get = static function ( $key ) use ( $business ) {
			return isset( $business[ $key ] ) ? trim( (string) $business[ $key ] ) : '';
		};

		$types = self::types();
		$type  = $get( 'type' );

		$node = array(
			'@context' => 'https://schema.org',
			'@type'    => isset( $types[ $type ] ) ? $type : 'LocalBusiness',
			'name'     => $get( 'name' ),
		);

		if ( '' !== $get( 'url' ) ) {
			$node['@id']  = rtrim( $get( 'url' ), '/' ) . '/#location-' . ( '' !== $get( 'id' ) ? $get( 'id' ) : '1' );
			$node['url']  = $get( 'url' );
		}

		foreach ( array(
			'telephone'   => 'telephone',
			'email'       => 'email',
			'price_range' => 'priceRange',
			'image'       => 'image',
			'description' => 'description',
		) as $field => $property ) {
			if ( '' !== $get( $field ) ) {
				$node[ $property ] = $get( $field );
			}
		}

		$address = array_filter(
			array(
				'streetAddress'   => $get( 'street' ),
				'addressLocality' => $get( 'city' ),
				'addressRegion'   => $get( 'region' ),
				'postalCode'      => $get( 'postcode' ),
				'addressCountry'  => $get( 'country' ),
			),
			static function ( $value ) {
				return '' !== $value;
			}
		);

		if ( ! empty( $address ) ) {
			$node['address'] = array_merge( array( '@type' => 'PostalAddress' ), $address );
		}

		if ( is_numeric( $get( 'latitude' ) ) && is_numeric( $get( 'longitude' ) ) ) {
			$node['geo'] = array(
				'@type'     => 'GeoCoordinates',
				'latitude'  => (float) $get( 'latitude' ),
				'longitude' => (float) $get( 'longitude' ),
			);
		}

		$hours = $schedule->to_opening_hours_specification();

		if ( ! empty( $hours ) ) {
			$node['openingHoursSpecification'] = $hours;
		}

		$special = self::special_hours( $schedule );

		if ( ! empty( $special ) ) {
			$node['specialOpeningHoursSpecification'] = $special;
		}

		$sameas = array_values(
			array_filter(
				array_map( 'trim', explode( "\n", $get( 'sameas' ) ) ),
				static function ( $value ) {
					return '' !== $value;
				}
			)
		);

		if ( ! empty( $sameas ) ) {
			$node['sameAs'] = $sameas;
		}

		return $node;
	}

	/**
	 * Convert date exceptions into specialOpeningHoursSpecification nodes.
	 *
	 * A closed day is expressed as opens/closes of 00:00, which is how Google
	 * documents a full-day closure. Annually repeating exceptions are expanded
	 * into the current and following calendar year, since schema.org requires
	 * concrete dates.
	 *
	 * @param LBSH_Schedule $schedule Schedule to read exceptions from.
	 * @return array
	 */
	private static function special_hours( LBSH_Schedule $schedule ) {
		$out  = array();
		$year = (int) ( new DateTimeImmutable( 'now', $schedule->timezone() ) )->format( 'Y' );

		foreach ( $schedule->exceptions() as $key => $periods ) {
			$dates = array();

			if ( preg_match( '/^\d{4}-\d{2}-\d{2}$/', (string) $key ) ) {
				$dates[] = $key;
			} elseif ( preg_match( '/^\d{2}-\d{2}$/', (string) $key ) ) {
				$dates[] = $year . '-' . $key;
				$dates[] = ( $year + 1 ) . '-' . $key;
			} else {
				continue;
			}

			$normalized = LBSH_Schedule::normalize_weekly( array( 'mon' => (array) $periods ) )['mon'];

			foreach ( $dates as $date ) {
				if ( empty( $normalized ) ) {
					$out[] = array(
						'@type'        => 'OpeningHoursSpecification',
						'validFrom'    => $date,
						'validThrough' => $date,
						'opens'        => '00:00',
						'closes'       => '00:00',
					);
					continue;
				}

				foreach ( $normalized as $period ) {
					$out[] = array(
						'@type'        => 'OpeningHoursSpecification',
						'validFrom'    => $date,
						'validThrough' => $date,
						'opens'        => $period['open'],
						'closes'       => $period['close'],
					);
				}
			}
		}

		return $out;
	}
}
