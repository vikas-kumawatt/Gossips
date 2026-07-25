import React from "react";
import { useNavigate } from "react-router";

const NotFoundPage = () => {

    const navigate = useNavigate();

    const handleClick = () => {
        navigate('/');
    }
  
    return (
    <div className=" h-screen flex flex-col items-center justify-center">
      <p className="font-medium">Not all who wander are lost, but this page is</p>
      <p className="text-neutral-500 pt-2 text-center">
        The link's not working or the page is gone. <br /> Go back to keep exploring.
      </p>
      <button
        className="p-1 px-4 bg-white text-black rounded-md mt-4 font-medium cursor-pointer hover:bg-white/90"
        onClick={handleClick}
      >
        Back
      </button>
    </div>
  );
};

export default NotFoundPage;
