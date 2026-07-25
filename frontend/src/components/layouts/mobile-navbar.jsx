import React from 'react'
import Navigation from '../navigations'

export default function MobileNavbar({ layoutContext }) {
    return (
        <div className="fixed sm:hidden bottom-0 left-0 z-50 w-full h-16 backdrop-blur-xl bg-neutral-950">
            <div className="grid h-full grid-cols-6 mx-auto w-full">
                <Navigation layoutContext={layoutContext} />
            </div>
        </div>
    )
}